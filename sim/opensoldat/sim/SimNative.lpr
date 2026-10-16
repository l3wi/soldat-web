program SimNative;
{$mode delphi}
{$H+}
uses cwstring, Classes, SysUtils, Math, fpjson, jsonparser, Anims, Constants,
  Game, Net, Parts, Sprites, Vector, Weapons, PhysFS, SimCore, SimRandom, CombatDiagnostics;
var
  Fixture: TJSONObject;
  TraceFile, ReceiptFile: Text;
  TraceOpen, ReceiptOpen: Boolean;
  CurrentTick: Integer;
  EventBuffer: array of Byte;
{$I ../../../tools/oracle/OracleTrace.inc}
procedure Check(Status: LongInt; const Operation: string);
begin if Status < 0 then raise Exception.Create(Operation + ': sim status ' + IntToStr(Status)); end;
procedure PutFile(const Filename, VirtualPath: string);
var Source: TFileStream; Bytes: array of Byte; P: Pointer;
begin
  Source := TFileStream.Create(Filename,fmOpenRead or fmShareDenyWrite);
  try
    if Source.Size > High(LongInt) then raise Exception.Create('Content file too large');
    SetLength(Bytes,Source.Size); P := nil;
    if Length(Bytes) <> 0 then begin Source.ReadBuffer(Bytes[0],Length(Bytes)); P := @Bytes[0]; end;
    Check(sim_vfs_put(PAnsiChar(VirtualPath),Length(VirtualPath),P,Length(Bytes)),'mount ' + VirtualPath);
  finally Source.Free; end;
end;
procedure MountDirectory(const Root, Relative: string);
var Search: TSearchRec; Names: TStringList; J: Integer; Full, Child: string;
begin
  Names := TStringList.Create;
  try
    Full := IncludeTrailingPathDelimiter(Root) + Relative;
    if FindFirst(IncludeTrailingPathDelimiter(Full) + '*',faAnyFile,Search) = 0 then
    begin
      repeat
        if (Search.Name <> '.') and (Search.Name <> '..') then Names.Add(Search.Name);
      until FindNext(Search) <> 0;
      FindClose(Search);
    end
    else if not DirectoryExists(Full) then raise Exception.Create('Content directory missing: ' + Full);
    Names.Sort;
    for J := 0 to Names.Count-1 do
    begin
      Child := Relative + Names[J]; Full := IncludeTrailingPathDelimiter(Root) + Child;
      if DirectoryExists(Full) then MountDirectory(Root,Child+'/')
      else if Names[J] <> 'manifest.json' then PutFile(Full,Child);
    end;
  finally Names.Free; end;
end;
procedure Set16(var Bytes: array of Byte; Offset: Integer; Value: Word);
begin Bytes[Offset] := Byte(Value); Bytes[Offset+1] := Byte(Value shr 8); end;
procedure SetControl(Slot: Integer; Obj: TJSONObject; Order: Word);
const Keys: array[0..11] of string = ('Left','Right','Up','Down','Fire','Jetpack',
  'ThrowNade','ChangeWeapon','ThrowWeapon','Reload','Prone','FlagThrow');
var Bytes: array[0..11] of Byte; Bits: Word; J: Integer;
begin
  FillChar(Bytes,SizeOf(Bytes),0); Bits := 0;
  if Obj <> nil then
  begin
    for J := 0 to 11 do if Obj.Get(Keys[J],False) then Bits := Bits or (Word(1) shl J);
    Set16(Bytes,0,Bits); Set16(Bytes,2,Word(Obj.Get('MouseAimX',0)));
    Set16(Bytes,4,Word(Obj.Get('MouseAimY',0))); Set16(Bytes,6,Word(Obj.Get('MouseDist',0)));
  end;
  Set16(Bytes,8,Order);
  Check(sim_set_input(Slot,MainTickCounter,@Bytes[0]),'set input');
end;
procedure InjectInputs;
var Inputs: TJSONArray; Input: TJSONObject; J, Slot: Integer;
  Selected: array[1..MAX_PLAYERS] of TJSONObject;
begin
  FillChar(Selected,SizeOf(Selected),0);
  Inputs := Fixture.Arrays['inputs'];
  for J := 0 to Inputs.Count-1 do
  begin
    Input := TJSONObject(Inputs[J]);
    if (CurrentTick >= Input.Integers['start']) and
       (CurrentTick < Input.Integers['start']+Input.Integers['ticks']) then
    begin
      Slot := Input.Integers['player'];
      if (Slot < 1) or (Slot > MAX_PLAYERS) or not Sprite[Slot].Active then
        raise Exception.Create('Input references inactive player');
      Selected[Slot] := Input;
    end;
  end;
  for Slot := 1 to MAX_PLAYERS do if Sprite[Slot].Active and
    ((Sprite[Slot].Player.ControlMethod<>BOT) or Sprite[Slot].Dummy) then
    if Selected[Slot] = nil then SetControl(Slot,nil,0)
    else SetControl(Slot,Selected[Slot].Objects['control'],Selected[Slot].Get('pressOrder',0));
end;
procedure InjectCommands(Tick: Integer);
var Commands: TJSONArray; Cmd: TJSONObject; J: Integer; Payload: AnsiString;
begin
  if Fixture.Find('commands') = nil then Exit;
  Commands := Fixture.Arrays['commands'];
  for J := 0 to Commands.Count-1 do
  begin
    Cmd := TJSONObject(Commands[J]);
    if Cmd.Integers['tick'] <> Tick then Continue;
    Payload := Cmd.AsJSON;
    Check(sim_command(Tick,PAnsiChar(Payload),Length(Payload)),'fixture command');
  end;
end;
procedure Receipt;
var Required, Count, J: Integer; Hex: string;
const Digits: string = '0123456789abcdef';
begin
  Required := sim_events(nil,0); Check(Required,'event size');
  if Length(EventBuffer) < Required then SetLength(EventBuffer,Required);
  Count := 0;
  if Required <> 0 then begin Count := sim_events(@EventBuffer[0],Length(EventBuffer)); Check(Count,'event drain'); end;
  if not ReceiptOpen then Exit;
  SetLength(Hex,Count*2);
  for J := 0 to Count-1 do
  begin Hex[J*2+1] := Digits[(EventBuffer[J] shr 4)+1]; Hex[J*2+2] := Digits[(EventBuffer[J] and 15)+1]; end;
  WriteLn(ReceiptFile,'{"tick":',CurrentTick,',"hash":"',
    LowerCase(IntToHex(sim_hash_state,16)),'","events":"',Hex,'"}');
end;
procedure TraceStage(const Stage: string; Entity: Integer);
begin
  CurrentTick := MainTickCounter;
  if Stage <> 'tick' then OracleDump(Stage,Entity);
end;
procedure Run;
var Source: TFileStream; Rules, MapName, Command, ReceiptPath, MapPath: AnsiString;
  Players: TJSONArray; Spec, Cmd, Header, RuleSpec: TJSONObject; J, K, TickCount: Integer;
  Seed: Int64;
begin
  if (ParamCount < 3) or (ParamCount > 4) then
    raise Exception.Create('Usage: sim-native FIXTURE TRACE CONTENT-DIR [TEST-MAPS-DIR]');
  Source := TFileStream.Create(ParamStr(1),fmOpenRead or fmShareDenyWrite);
  try Fixture := TJSONObject(GetJSON(Source)); finally Source.Free; end;
  if Fixture.Integers['version'] <> 1 then raise Exception.Create('Unsupported fixture version');
  TickCount := Fixture.Integers['ticks'];
  if TickCount < 1 then raise Exception.Create('Fixture ticks must be positive');
  MountDirectory(ParamStr(3),'');
  MapName := Fixture.Strings['map']; Rules := '{}'; Seed := Fixture.Int64s['seed'];
  RuleSpec := TJSONObject.Create;
  try
    if Fixture.Find('rules') <> nil then
      for K := 0 to Fixture.Objects['rules'].Count-1 do
        RuleSpec.Add(Fixture.Objects['rules'].Names[K],Fixture.Objects['rules'].Items[K].Clone);
    if GetEnvironmentVariable('SIM_RNG_POLICY') <> '' then
    begin
      RuleSpec.Delete('rng');
      RuleSpec.Add('rng',GetEnvironmentVariable('SIM_RNG_POLICY'));
    end;
    Rules := RuleSpec.AsJSON;
  finally RuleSpec.Free; end;
  MapPath := Fixture.Get('mapPath','');
  if (MapPath <> '') and (Fixture.Find('mapDirectory') <> nil) then
  begin
    if ParamCount = 4 then MapPath := IncludeTrailingPathDelimiter(ParamStr(4)) + ExtractFileName(MapPath);
    PutFile(MapPath,'maps/'+MapName+'.pms');
  end;
  Check(sim_init(PAnsiChar(Rules),Length(Rules),LongWord(Seed),0,0),'init');
  Check(sim_load_map(PAnsiChar(MapName),Length(MapName)),'load map');
  Players := Fixture.Arrays['players'];
  if (Players.Count < 1) or (Players.Count > MAX_PLAYERS) then raise Exception.Create('Invalid fixture players');
  for J := 0 to Players.Count-1 do
  begin
    Spec := TJSONObject(Players[J]); Cmd := TJSONObject.Create;
    try
      Cmd.Add('kind','join'); Cmd.Add('slot',J+1); Cmd.Add('team',Spec.Integers['team']);
      Cmd.Add('spawn',Spec.Integers['spawnpoint']);
      if Spec.Find('x') <> nil then Cmd.Add('x',Spec.Floats['x']);
      if Spec.Find('y') <> nil then Cmd.Add('y',Spec.Floats['y']);
      if Spec.Find('health') <> nil then Cmd.Add('health',Spec.Floats['health']);
      if Spec.Find('heldFlag') <> nil then Cmd.Add('heldFlag',Spec.Integers['heldFlag']);
      for K := 0 to Spec.Count-1 do
        if (Spec.Names[K] = 'weapon') or (Spec.Names[K] = 'secondaryWeapon') or
           (Spec.Names[K] = 'ammo') or (Spec.Names[K] = 'grenades') or
           (Spec.Names[K] = 'vest') or (Spec.Names[K] = 'control') or
           (Spec.Names[K] = 'bot') then Cmd.Add(Spec.Names[K],Spec.Items[K].Clone);
      if (Spec.Find('control') = nil) and
         (GetEnvironmentVariable('SIM_CONTROL_POLICY') = 'authoritative') then
        Cmd.Add('control','authoritative');
      Command := Cmd.AsJSON; Check(sim_command(0,PAnsiChar(Command),Length(Command)),'join');
    finally Cmd.Free; end;
  end;
  InjectCommands(0);
  AssignFile(TraceFile,ParamStr(2)); Rewrite(TraceFile); TraceOpen := True;
  ReceiptPath := GetEnvironmentVariable('SIM_RECEIPT_OUT');
  if ReceiptPath <> '' then begin AssignFile(ReceiptFile,ReceiptPath); Rewrite(ReceiptFile); ReceiptOpen := True; end;
  Header := TJSONObject.Create;
  Header.Add('type','header'); Header.Add('version',1);
  Header.Add('upstream','bf43a43bdd7a069e02c906768807f66e621b2888');
  Header.Add('compiler',{$I %FPCVERSION%}); Header.Add('map',Fixture.Strings['map']);
  Header.Add('contentSetHash',Fixture.Strings['contentSetHash']);
  Header.Add('seed',Fixture.Int64s['seed']); Header.Add('ticks',TickCount); Header.Add('jetCapacity',Map.StartJet);
  Emit(Header); CurrentTick := 0; OracleDump('initial',0); Receipt;
  SimTraceHook := TraceStage;
  for J := 1 to TickCount do
  begin
    CurrentTick := J; InjectInputs; Check(sim_step(0),'step');
    InjectCommands(J); OracleDump('tick',0); Receipt;
  end;
  SimTraceHook := nil;
  CloseFile(TraceFile); TraceOpen := False;
  if ReceiptOpen then begin CloseFile(ReceiptFile); ReceiptOpen := False; end;
  Fixture.Free;
end;
begin
  try Run;
  except on E: Exception do begin WriteLn(StdErr,E.Message); Halt(1); end; end;
end.
