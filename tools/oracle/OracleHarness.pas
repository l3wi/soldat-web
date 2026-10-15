unit OracleHarness;

interface

procedure RunOracle;
procedure OracleDump(const Stage: string; Entity: Integer);

implementation

uses
  Classes, SysUtils, Math, fpjson, jsonparser, PhysFS,
  Anims, Constants, Cvar, Demo, Game, LogFile, Net, Parts, PolyMap, Server,
  ServerLoop, Sprites, Things, Util, Vector, Weapons;

var
  Fixture: TJSONObject;
  TraceFile: Text;
  TraceOpen: Boolean = False;
  CurrentTick: Integer = 0;
  WasRunningLeft, WasJumping: array[1..MAX_PLAYERS] of Boolean;


{$I OracleTrace.inc}

function ReadControl(Data: TJSONObject): TControl;
begin
  Result := Default(TControl);
  Result.Left := Data.Get('Left', False);
  Result.Right := Data.Get('Right', False);
  Result.Up := Data.Get('Up', False);
  Result.Down := Data.Get('Down', False);
  Result.Fire := Data.Get('Fire', False);
  Result.Jetpack := Data.Get('Jetpack', False);
  Result.ThrowNade := Data.Get('ThrowNade', False);
  Result.ChangeWeapon := Data.Get('ChangeWeapon', False);
  Result.ThrowWeapon := Data.Get('ThrowWeapon', False);
  Result.Reload := Data.Get('Reload', False);
  Result.Prone := Data.Get('Prone', False);
  Result.FlagThrow := Data.Get('FlagThrow', False);
  Result.MouseAimX := Data.Get('MouseAimX', 0);
  Result.MouseAimY := Data.Get('MouseAimY', 0);
  Result.MouseDist := Data.Get('MouseDist', 0);
end;

procedure InjectInputs;
var
  Inputs: TJSONArray;
  Input: TJSONObject;
  Selected: array[1..MAX_PLAYERS] of TJSONObject;
  I, Slot, Order: Integer;
begin
  for I := 1 to MAX_SPRITES do
    if Sprite[I].Active then
    begin
      Sprite[I].Control := Default(TControl);
      NoClientUpdateTime[I] := 0;
    end;
  for I := 1 to MAX_PLAYERS do Selected[I] := nil;
  Inputs := Fixture.Arrays['inputs'];
  for I := 0 to Inputs.Count - 1 do
  begin
    Input := TJSONObject(Inputs[I]);
    if (CurrentTick >= Input.Integers['start']) and
       (CurrentTick < Input.Integers['start'] + Input.Integers['ticks']) then
    begin
      Slot := Input.Integers['player'];
      if (Slot < 1) or (Slot > MAX_PLAYERS) or not Sprite[Slot].Active then
        raise Exception.Create('Input references inactive player');
      Selected[Slot] := Input;
    end;
  end;
  // Resolve exactly once per player, including neutral ticks. Later segments win.
  for Slot := 1 to MAX_PLAYERS do
    if Sprite[Slot].Active then
    begin
      Input := Selected[Slot];
      Order := 0;
      if Input <> nil then
      begin
        Sprite[Slot].Control := ReadControl(Input.Objects['control']);
        Order := Input.Get('pressOrder', 0);
      end;
      if Sprite[Slot].Control.Left and Sprite[Slot].Control.Right and (Order <> 0) then
      begin
        if (Order and 3) = 3 then raise Exception.Create('Conflicting pressOrder bits');
        if (Order and 3) <> 0 then WasRunningLeft[Slot] := (Order and 1) <> 0;
        // The client resolves first/new direction before serializing server TControl.
        if WasJumping[Slot] then
        begin
          Sprite[Slot].Control.Left := WasRunningLeft[Slot];
          Sprite[Slot].Control.Right := not WasRunningLeft[Slot];
        end
        else
        begin
          Sprite[Slot].Control.Left := not WasRunningLeft[Slot];
          Sprite[Slot].Control.Right := WasRunningLeft[Slot];
        end;
      end
      else if not (Sprite[Slot].Control.Left and Sprite[Slot].Control.Right) then
      begin
        WasRunningLeft[Slot] := Sprite[Slot].Control.Left;
        WasJumping[Slot] := Sprite[Slot].Control.Up;
      end;
    end;
end;

procedure RunOracle;
var
  Source: TFileStream;
  Info: TMapInfo;
  Players: TJSONArray;
  PlayerSpec, Header: TJSONObject;
  P: TPlayer;
  Pos, Velocity: TVector2;
  I, Spawn, Slot, FlagSlot, FlagStyle, TickCount, Tick: Integer;
begin
  if ParamCount <> 4 then
    raise Exception.Create('Usage: opensoldatserver FIXTURE TRACE BASE-SMOD USER-DIR');
  Source := TFileStream.Create(ParamStr(1), fmOpenRead or fmShareDenyWrite);
  try Fixture := TJSONObject(GetJSON(Source)); finally Source.Free; end;
  if Fixture.Integers['version'] <> 1 then raise Exception.Create('Unsupported fixture version');
  TickCount := Fixture.Integers['ticks'];
  if TickCount < 1 then raise Exception.Create('Fixture ticks must be positive');
  DefaultFormatSettings.DecimalSeparator := '.';
  SetExceptionMask([exInvalidOp, exDenormalized, exZeroDivide, exOverflow,
    exUnderflow, exPrecision]);
  RandSeed := Fixture.Int64s['seed'];
  CvarInit;
  sv_gamemode.SetValue(GAMESTYLE_DEATHMATCH);
  sv_bonus_frequency.SetValue(0);
  sv_survivalmode.SetValue(False);
  sv_realisticmode.SetValue(False);
  sv_lobby.SetValue(False);
  sc_enable.SetValue(False);
  log_enable.SetValue(False);
  demo_autorecord.SetValue(False);
  sv_timelimit.SetValue(360000);
  UserDirectory := IncludeTrailingPathDelimiter(ParamStr(4));
  BaseDirectory := ExtractFilePath(ParamStr(3));
  MainConsole.CountMax := 7;
  if not PhysFS_Init(PChar(ParamStr(0))) then raise Exception.Create('PhysFS init failed');
  if not PhysFS_mount(PChar(ParamStr(3)), '/', False) then raise Exception.Create('PhysFS mount failed');
  // A test-only raw PMS mount may shadow a stock basename without editing base.
  if Fixture.Get('mapDirectory', '') <> '' then
    if not PhysFS_mount(PChar(Fixture.Strings['mapDirectory']), '/', False) then
      raise Exception.Create('Fixture map mount failed');
  DummyPlayer := TPlayer.Create;
  for I := 1 to MAX_SPRITES do Sprite[I].Player := DummyPlayer;
  for I := 1 to MAIN_WEAPONS do WeaponActive[I] := 1;
  LoadAnimObjects('');
  if not GetMapInfo(Fixture.Strings['map'], UserDirectory, Info) then
    raise Exception.Create('Map not found');
  if not Map.LoadMap(Info) then raise Exception.Create('Map load failed');
  StartHealth := DEFAULT_HEALTH;
  LoadWeapons('weapons');
  MapChangeCounter := -60;
  BulletTimeTimer := -1;
  TimeLimitCounter := 360000;
  Players := Fixture.Arrays['players'];
  if (Players.Count < 1) or (Players.Count > MAX_PLAYERS) then raise Exception.Create('Invalid player count');
  for I := 0 to Players.Count - 1 do
  begin
    PlayerSpec := TJSONObject(Players[I]);
    Spawn := PlayerSpec.Integers['spawnpoint'];
    if (Spawn < 1) or (Spawn > MAX_SPAWNPOINTS) then raise Exception.Create('Invalid spawnpoint');
    if not Map.Spawnpoints[Spawn].Active then raise Exception.Create('Inactive spawnpoint');
    Pos.X := Map.Spawnpoints[Spawn].X;
    Pos.Y := Map.Spawnpoints[Spawn].Y;
    if PlayerSpec.Find('x') <> nil then Pos.X := PlayerSpec.Floats['x'];
    if PlayerSpec.Find('y') <> nil then Pos.Y := PlayerSpec.Floats['y'];
    Velocity := Default(TVector2);
    P := TPlayer.Create;
    P.Team := PlayerSpec.Integers['team'];
    P.ControlMethod := HUMAN;
    P.Name := 'oracle-' + IntToStr(I + 1);
    Slot := CreateSprite(Pos, Velocity, 1, I + 1, P, True);
    if Slot <> I + 1 then raise Exception.Create('Unexpected sprite slot');
    if PlayerSpec.Find('health') <> nil then Sprite[Slot].Health := PlayerSpec.Floats['health'];
    FlagStyle := PlayerSpec.Get('heldFlag', 0);
    if FlagStyle <> 0 then
    begin
      if (FlagStyle < 1) or (FlagStyle > 3) then raise Exception.Create('Invalid heldFlag style');
      FlagSlot := CreateThing(Pos, Slot, FlagStyle, 255);
      if FlagSlot < 1 then raise Exception.Create('Flag creation failed');
      Thing[FlagSlot].HoldingSprite := Slot;
      Sprite[Slot].HoldedThing := FlagSlot;
    end;
  end;
  AssignFile(TraceFile, ParamStr(2));
  Rewrite(TraceFile);
  TraceOpen := True;
  Header := TJSONObject.Create;
  Header.Add('type', 'header');
  Header.Add('version', 1);
  Header.Add('upstream', 'bf43a43bdd7a069e02c906768807f66e621b2888');
  Header.Add('compiler', {$I %FPCVERSION%});
  Header.Add('map', Fixture.Strings['map']);
  Header.Add('contentSetHash', Fixture.Strings['contentSetHash']);
  Header.Add('seed', Fixture.Int64s['seed']);
  Header.Add('ticks', TickCount);
  Header.Add('jetCapacity', Map.StartJet);
  Emit(Header);
  OracleDump('initial', 0);
  for Tick := 1 to TickCount do
  begin
    CurrentTick := Tick;
    Inc(Ticks);
    Inc(ServerTickCounter);
    Inc(MainTickCounter);
    InjectInputs;
    UpdateFrame;
    OracleDump('tick', 0);
  end;
  CloseFile(TraceFile);
  TraceOpen := False;
  Fixture.Free;
end;

end.
