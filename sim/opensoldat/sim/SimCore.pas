unit SimCore;
{$mode delphi}
{$H+}
interface
const
  SIM_OK = 0;
  SIM_INVALID = -1;
  SIM_NOT_INITIALIZED = -2;
  SIM_MISSING = -3;
  SIM_UNSUPPORTED = -4;
  SIM_CAPACITY = -5;
  SIM_MALFORMED = -6;
type TSimTraceHook = procedure(const Stage: string; Entity: Integer);
var SimTraceHook: TSimTraceHook = nil;
function sim_version: LongWord;
function sim_alloc(Size: LongWord): Pointer;
procedure sim_free(Buffer: Pointer);
function sim_vfs_put(Path: Pointer; PathLength: LongWord; Data: Pointer; DataLength: LongWord): LongInt;
function sim_init(Rules: Pointer; RulesLength, SeedLo, SeedHi, Flags: LongWord): LongInt;
function sim_load_map(Name: Pointer; NameLength: LongWord): LongInt;
function sim_command(Tick: LongWord; Data: Pointer; Length: LongWord): LongInt;
function sim_set_input(Slot, Tick: LongWord; Data: Pointer): LongInt;
function sim_step(Flags: LongWord): LongInt;
function sim_events(Buffer: Pointer; Capacity: LongWord): LongInt;
function sim_render_view: Pointer;
function sim_save_state(Buffer: Pointer; Capacity: LongWord): LongInt;
function sim_load_state(Buffer: Pointer; Length: LongWord): LongInt;
function sim_hash_state: QWord;
function sim_trace_state(Buffer: Pointer; Capacity: LongWord): LongInt;
function fx_step: LongInt;
function fx_render_view: LongInt;
implementation
uses Classes, SysUtils, Math, fpjson, jsonparser, PhysFS, Anims,
  Constants, Cvar, Demo, Game, Net, Parts, PolyMap, Server, Sprites,
  Things, Bullets, Util, Vector, Weapons, SimState, SimRender, SimEvents,
  NetworkServerSprite, SimAnimationContent, SimRandom;
var
  Initialized, MapLoaded, CvarsReady: Boolean;
  Fixture: TJSONObject = nil;
  TraceOpen: Boolean;
  CurrentTick: Integer;
  SimTraceRow: AnsiString;
{$DEFINE SIM_TRACE_BUFFER}
{$I ../../../tools/oracle/OracleTrace.inc}
{$UNDEF SIM_TRACE_BUFFER}
function sim_version: LongWord;
begin Result := SIM_ABI_VERSION; end;
function sim_alloc(Size: LongWord): Pointer;
begin
  Result := nil;
  if (Size = 0) or (Size > 64*1024*1024) then Exit;
  GetMem(Result, Size);
end;
procedure sim_free(Buffer: Pointer);
begin if Buffer <> nil then FreeMem(Buffer); end;
function TextArgument(Data: Pointer; Length: LongWord; out Value: AnsiString): Boolean;
var J: LongWord;
begin
  Result := False;
  if (Data = nil) or (Length = 0) or (Length > 65535) then Exit;
  for J := 0 to Length-1 do if PByte(Data)[J] = 0 then Exit;
  SetString(Value, PAnsiChar(Data), Length); Result := True;
end;
function ReadObject(Data: Pointer; Length: LongWord; out Obj: TJSONObject): Boolean;
var S: AnsiString; Parsed: TJSONData;
begin
  Obj := nil; Result := False;
  if not TextArgument(Data, Length, S) then Exit;
  try
    Parsed := GetJSON(S);
    if Parsed.JSONType <> jtObject then begin Parsed.Free; Exit; end;
    Obj := TJSONObject(Parsed); Result := True;
  except on E: Exception do Result := False; end;
end;
function sim_vfs_put(Path: Pointer; PathLength: LongWord; Data: Pointer; DataLength: LongWord): LongInt;
var S: AnsiString;
begin
  if Initialized then Exit(SIM_INVALID);
  if not TextArgument(Path,PathLength,S) or ((Data = nil) and (DataLength <> 0)) then Exit(SIM_INVALID);
  if SimVFSPut(S,Data,DataLength) then Result := SIM_OK else Result := SIM_INVALID;
end;
function RulesSupported(Obj: TJSONObject): Boolean;
var J: Integer; Name: AnsiString; Value: TJSONData;
begin
  Result := False;
  for J := 0 to Obj.Count-1 do
  begin
    Name := Obj.Names[J]; Value := Obj.Items[J];
    if Name = 'mode' then
    begin if (Value.JSONType <> jtString) or (Value.AsString <> 'dm') then Exit; end
    else if Name = 'rng' then
    begin if (Value.JSONType <> jtString) or (Value.AsString <> 'original') then Exit; end
    else if (Name = 'ai') or (Name = 'realistic') or (Name = 'survival') then
    begin if (Value.JSONType <> jtBoolean) or Value.AsBoolean then Exit; end
    else if Name = 'bonusFrequency' then
    begin if (Value.JSONType <> jtNumber) or (Value.AsFloat <> 0) then Exit; end
    else if Name = 'tickRate' then
    begin if (Value.JSONType <> jtNumber) or (Value.AsFloat <> 60) then Exit; end
    else Exit;
  end;
  Result := True;
end;
procedure ClearEntities;
var J: Integer;
begin
  for J := 1 to MAX_SPRITES do
  begin
    if Sprite[J].IsPlayerObjectOwner and (Sprite[J].Player <> DummyPlayer) then Sprite[J].Player.Free;
    Sprite[J] := Default(TSprite);
    Sprite[J].Player := DummyPlayer;
  end;
  for J := 1 to MAX_BULLETS do Bullet[J] := Default(TBullet);
  for J := 1 to MAX_THINGS do Thing[J] := Default(TThing);
end;
function sim_init(Rules: Pointer; RulesLength, SeedLo, SeedHi, Flags: LongWord): LongInt;
const RequiredFiles: array[0..49] of PChar = (
  'anims/stoi.poa', 'anims/biega.poa', 'anims/biegatyl.poa',
  'anims/skok.poa', 'anims/skokwbok.poa', 'anims/spada.poa',
  'anims/kuca.poa', 'anims/kucaidzie.poa', 'anims/laduje.poa',
  'anims/rzuca.poa', 'anims/odrzut.poa', 'anims/odrzut2.poa',
  'anims/shotgun.poa', 'anims/clipout.poa', 'anims/clipin.poa',
  'anims/slideback.poa', 'anims/change.poa', 'anims/wyrzuca.poa',
  'anims/bezbroni.poa', 'anims/bije.poa', 'anims/strzala.poa',
  'anims/barret.poa', 'anims/skokdolobrot.poa', 'anims/skokdolobrottyl.poa',
  'anims/kucaidzietyl.poa', 'anims/cigar.poa', 'anims/match.poa',
  'anims/smoke.poa', 'anims/wipe.poa', 'anims/krocze.poa',
  'anims/szcza.poa', 'anims/samo.poa', 'anims/samo2.poa',
  'anims/takeoff.poa', 'anims/lezy.poa', 'anims/cieszy.poa',
  'anims/celuje.poa', 'anims/gora.poa', 'anims/lezyidzie.poa',
  'anims/wstaje.poa', 'anims/celujeodrzut.poa', 'anims/goraodrzut.poa',
  'anims/kolba.poa', 'anims/rucha.poa', 'objects/gostek.po',
  'objects/kit.po', 'objects/flag.po', 'objects/para.po',
  'objects/stat.po', 'objects/karabin.po');
var Obj: TJSONObject; J: Integer;
begin
  if Initialized then Exit(SIM_UNSUPPORTED);
  if (Flags <> 0) or (SeedHi <> 0) then Exit(SIM_UNSUPPORTED);
  if not ReadObject(Rules,RulesLength,Obj) then Exit(SIM_MALFORMED);
  try if not RulesSupported(Obj) then Exit(SIM_UNSUPPORTED); finally Obj.Free; end;
  for J := Low(RequiredFiles) to High(RequiredFiles) do
    if not PHYSFS_exists(RequiredFiles[J]) then Exit(SIM_MISSING);
  SetExceptionMask([exInvalidOp,exDenormalized,exZeroDivide,exOverflow,exUnderflow,exPrecision]);
  DefaultFormatSettings.DecimalSeparator := '.';
  SimResetOriginalRNG(SeedLo);
  if not CvarsReady then begin CvarInit; CvarsReady := True; end;
  sv_gamemode.SetValue(GAMESTYLE_DEATHMATCH);
  sv_bonus_frequency.SetValue(0); sv_survivalmode.SetValue(False);
  sv_realisticmode.SetValue(False); sv_lobby.SetValue(False);
  sc_enable.SetValue(False); log_enable.SetValue(False);
  demo_autorecord.SetValue(False); sv_timelimit.SetValue(360000);
  UserDirectory := ''; BaseDirectory := ''; ModDir := '';
  MainConsole.CountMax := 7;
  if DummyPlayer = nil then DummyPlayer := TPlayer.Create;
  ClearEntities;
  for J := 1 to MAIN_WEAPONS do WeaponActive[J] := 1;
  Ticks := 0; MainTickCounter := 0; ServerTickCounter := 0;
  PlayersNum := 0; BotsNum := 0; SpectatorsNum := 0;
  SinusCounter := 0; WaveRespawnCounter := 0; WaveRespawnTime := 0;
  VoteActive := False; VoteTimeRemaining := -1;
  for J := 1 to MAX_PLAYERS do
  begin
    SimWasJumping[J] := False; SimWasRunningLeft[J] := False;
    NoClientUpdateTime[J] := 0;
  end;
  LoadAnimObjects('');
  SimBindAnimationContent;
  Initialized := True; MapLoaded := False;
  SimEventsReset; SimResetRender;
  Result := SIM_OK;
end;
function sim_load_map(Name: Pointer; NameLength: LongWord): LongInt;
var S: AnsiString; Info: TMapInfo; J: Integer;
begin
  if not Initialized then Exit(SIM_NOT_INITIALIZED);
  if not TextArgument(Name,NameLength,S) then Exit(SIM_INVALID);
  if MapLoaded then Exit(SIM_UNSUPPORTED);
  if not GetMapInfo(S,UserDirectory,Info) then Exit(SIM_MISSING);
  if not Map.LoadMap(Info) then Exit(SIM_MALFORMED);
  StartHealth := DEFAULT_HEALTH;
  LoadWeapons('weapons');
  MapChangeCounter := -60; BulletTimeTimer := -1; TimeLimitCounter := 360000;
  for J := 1 to MAX_PLAYERS do Sprite[J].Player := DummyPlayer;
  MapLoaded := True; SimResetRender;
  Result := SIM_OK;
end;
function JsonInteger(Obj: TJSONObject; const Key: string; DefaultValue: Int64; out Value: Int64): Boolean;
var D: TJSONData; X: Double;
begin
  D := Obj.Find(Key); Value := DefaultValue;
  if D = nil then Exit(True);
  if D.JSONType <> jtNumber then Exit(False);
  X := D.AsFloat;
  Result := not IsNan(X) and not IsInfinite(X) and (X >= Low(LongInt)) and (X <= High(LongInt)) and (Frac(X) = 0);
  if Result then Value := D.AsInt64;
end;
function sim_command(Tick: LongWord; Data: Pointer; Length: LongWord): LongInt;
var Obj: TJSONObject; Kind, Key: string; S, Team, Spawn, Flag: Int64;
  Position, Velocity: TVector2; P: TPlayer; J, Created: Integer; Health: Single; D: TJSONData;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  if Tick <> LongWord(MainTickCounter) then Exit(SIM_INVALID);
  if not ReadObject(Data,Length,Obj) then Exit(SIM_MALFORMED);
  try
    D := Obj.Find('kind'); if (D = nil) or (D.JSONType <> jtString) then Exit(SIM_MALFORMED);
    Kind := D.AsString;
    if (Kind <> 'join') and (Kind <> 'leave') and (Kind <> 'team') and (Kind <> 'spawn') then Exit(SIM_UNSUPPORTED);
    for J := 0 to Obj.Count-1 do
    begin
      Key := Obj.Names[J];
      if (Key <> 'kind') and (Key <> 'slot') and (Key <> 'team') and (Key <> 'spawn') and
         (Key <> 'x') and (Key <> 'y') and (Key <> 'health') and (Key <> 'heldFlag') then Exit(SIM_UNSUPPORTED);
    end;
    if (Obj.Find('slot') = nil) or not JsonInteger(Obj,'slot',0,S) or (S < 1) or (S > MAX_PLAYERS) then Exit(SIM_INVALID);
    if not JsonInteger(Obj,'team',0,Team) or (Team < 0) or (Team > TEAM_SPECTATOR) then Exit(SIM_INVALID);
    if Kind = 'leave' then
    begin
      if not Sprite[S].Active then Exit(SIM_INVALID);
      Sprite[S].Kill; SimResetRender; Exit(SIM_OK);
    end;
    if Kind = 'team' then
    begin
      if not Sprite[S].Active or (Obj.Find('team') = nil) then Exit(SIM_INVALID);
      Sprite[S].ChangeTeam(Team,True); SimResetRender; Exit(SIM_OK);
    end;
    if (Kind = 'join') and Sprite[S].Active then Exit(SIM_INVALID);
    if (Kind = 'spawn') and not Sprite[S].Active then Exit(SIM_INVALID);
    if not JsonInteger(Obj,'spawn',1,Spawn) or (Spawn < 1) or (Spawn > MAX_SPAWNPOINTS) then Exit(SIM_INVALID);
    if not Map.Spawnpoints[Spawn].Active then Exit(SIM_MISSING);
    Position.X := Map.Spawnpoints[Spawn].X; Position.Y := Map.Spawnpoints[Spawn].Y;
    Health := StartHealth;
    for J := 0 to 2 do
    begin
      case J of 0: Key := 'x'; 1: Key := 'y'; else Key := 'health'; end;
      D := Obj.Find(Key);
      if D <> nil then
      begin
        if D.JSONType <> jtNumber then Exit(SIM_MALFORMED);
        if IsNan(D.AsFloat) or IsInfinite(D.AsFloat) or (Abs(D.AsFloat) > 1000000) then Exit(SIM_INVALID);
        case J of 0: Position.X := D.AsFloat; 1: Position.Y := D.AsFloat; else Health := D.AsFloat; end;
      end;
    end;
    if not JsonInteger(Obj,'heldFlag',0,Flag) or (Flag < 0) or (Flag > 3) then Exit(SIM_INVALID);
    if Flag <> 0 then
    begin
      Created := 0;
      for J := 1 to MAX_THINGS do if not Thing[J].Active then begin Created := J; Break; end;
      if Created = 0 then Exit(SIM_CAPACITY);
    end;
    Velocity := Default(TVector2);
    if Kind = 'join' then
    begin
      P := TPlayer.Create; P.Team := Team; P.ControlMethod := HUMAN;
      P.Name := 'oracle-' + IntToStr(S);
    end
    else P := Sprite[S].Player;
    Created := CreateSprite(Position,Velocity,1,S,P,True);
    if Created <> S then Exit(SIM_CAPACITY);
    Sprite[S].Health := Health;
    if Flag <> 0 then
    begin
      Created := CreateThing(Position,S,Flag,255);
      if Created < 1 then Exit(SIM_CAPACITY);
      Thing[Created].HoldingSprite := S; Sprite[S].HoldedThing := Created;
    end;
    SimResetRender; Result := SIM_OK;
  finally Obj.Free; end;
end;
function Read16(Data: PByte; Offset: Integer): Word;
begin Result := Word(Data[Offset]) or (Word(Data[Offset+1]) shl 8); end;
function sim_set_input(Slot, Tick: LongWord; Data: Pointer): LongInt;
var Bits, Order: Word; C: TControl;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  if (Slot < 1) or (Slot > MAX_PLAYERS) or not Sprite[Slot].Active or
    (Tick <> LongWord(MainTickCounter)) or (Data = nil) then Exit(SIM_INVALID);
  Bits := Read16(Data,0); Order := Read16(Data,8);
  if (Bits and $F000 <> 0) or (Order and $FFF0 <> 0) or (Read16(Data,10) <> 0) or
     ((Order and 3) = 3) or ((Order and 12) = 12) then Exit(SIM_INVALID);
  C := Default(TControl);
  C.Left := Bits and 1 <> 0; C.Right := Bits and 2 <> 0;
  C.Up := Bits and 4 <> 0; C.Down := Bits and 8 <> 0;
  C.Fire := Bits and 16 <> 0; C.Jetpack := Bits and 32 <> 0;
  C.ThrowNade := Bits and 64 <> 0; C.ChangeWeapon := Bits and 128 <> 0;
  C.ThrowWeapon := Bits and 256 <> 0; C.Reload := Bits and 512 <> 0;
  C.Prone := Bits and 1024 <> 0; C.FlagThrow := Bits and 2048 <> 0;
  C.MouseAimX := SmallInt(Read16(Data,2)); C.MouseAimY := SmallInt(Read16(Data,4));
  C.MouseDist := SmallInt(Read16(Data,6));
  if C.Left and C.Right then
  begin
    { Zero order means already resolved server controls, not client sampling. }
    if Order <> 0 then
    begin
      if Order and 3 <> 0 then SimWasRunningLeft[Slot] := Order and 1 <> 0;
      if SimWasJumping[Slot] then C.Left := SimWasRunningLeft[Slot]
      else C.Left := not SimWasRunningLeft[Slot];
      C.Right := not C.Left;
    end;
  end
  else
  begin
    SimWasRunningLeft[Slot] := C.Left; SimWasJumping[Slot] := C.Up;
  end;
  Sprite[Slot].Control := C; NoClientUpdateTime[Slot] := 0;
  Result := SIM_OK;
end;
procedure Stage(const Name: string; Entity: Integer = 0);
begin if Assigned(SimTraceHook) then SimTraceHook(Name,Entity); end;
procedure UpdateMovementFrame;
var I,J: Integer;
begin
  if MapChangeCounter < 0 then
  begin
    for J := 1 to MAX_SPRITES do
      if Sprite[J].Active and not Sprite[J].DeadMeat and Sprite[J].IsNotSpectator then
      begin
        for I := MAX_OLDPOS downto 1 do OldSpritePos[J,I] := OldSpritePos[J,I-1];
        OldSpritePos[J,0] := SpriteParts.Pos[J];
      end;
    for J := 1 to MAX_SPRITES do
      if Sprite[J].Active and Sprite[J].IsNotSpectator then SpriteParts.DoEulerTimeStepFor(J);
    Stage('sprite-parts');
    for J := 1 to MAX_SPRITES do if Sprite[J].Active then begin Sprite[J].Update; Stage('sprite',J); end;
    for J := 1 to MAX_BULLETS do if Bullet[J].Active then Bullet[J].Update;
    Stage('bullets');
    BulletParts.DoEulerTimeStep; Stage('bullet-parts');
    for J := 1 to MAX_THINGS do if Thing[J].Active then Thing[J].Update;
    Stage('things');
  end;
  { Original ServerLoop.UpdateFrame remainder for supported normal DM rules.
    Bonus spawning is disabled at init; networking, logs and UI are not gameplay. }
  if BulletTimeTimer > -1 then Dec(BulletTimeTimer);
  if BulletTimeTimer = 0 then begin ToggleBulletTime(False); BulletTimeTimer := -1; end
  else if BulletTimeTimer < 1 then
  begin
    if (MapChangeCounter > -60) and (MapChangeCounter < 99999999) then Dec(MapChangeCounter);
    if (MapChangeCounter < 0) and (MapChangeCounter > -59) then ChangeMap;
    if MainTickCounter mod SECOND = 0 then
    begin
      for J := 1 to MAX_SPRITES do if Sprite[J].Active then
      begin
        if sv_antimassflag.Value then
        begin
          Sprite[J].Player.GrabsPerSecond := 0; Sprite[J].Player.ScoresPerSecond := 0;
          Sprite[J].Player.GrabbedInBase := False;
        end;
        if Sprite[J].Player.ChatWarnings > 0 then Dec(Sprite[J].Player.ChatWarnings);
      end;
    end;
    if sv_healthcooldown.Value > 0 then
      if MainTickCounter mod (sv_healthcooldown.Value*SECOND) = 0 then
        for J := 1 to MAX_SPRITES do if Sprite[J].Active and Sprite[J].HasPack then Sprite[J].HasPack := False;
    if MainTickCounter mod MINUTE = 0 then
      for J := 1 to MAX_SPRITES do if Sprite[J].Active then Inc(Sprite[J].Player.PlayTime);
    if MainTickCounter mod (SECOND*10) = 0 then
      if (PlayersNum = 0) and (MapChangeCounter > 99999999) then MapChangeCounter := -60;
    SinusCounter := SinusCounter + ILUMINATESPEED;
    Dec(WaveRespawnCounter); if WaveRespawnCounter < 1 then WaveRespawnCounter := WaveRespawnTime;
    for J := 1 to MAX_SPRITES do if VoteCooldown[J] > -1 then Dec(VoteCooldown[J]);
    if (MapChangeCounter < 99999999) and (TimeLimitCounter > 0) then Dec(TimeLimitCounter);
    if TimeLimitCounter = 1 then NextMap;
    TimeLeftMin := TimeLimitCounter div MINUTE;
    TimeLeftSec := (TimeLimitCounter-TimeLeftMin*MINUTE) div 60;
    TimerVote;
    if not sv_advancemode.Value then
      for J := 1 to MAX_SPRITES do for I := 1 to 10 do WeaponSel[J,I] := 1;
  end;
  if PlayersTeamNum[2] = PlayersTeamNum[1] then HTFTime := sv_htf_pointstime.Value*60;
end;
function sim_step(Flags: LongWord): LongInt;
var J: Integer;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  if Flags and not LongWord(1) <> 0 then Exit(SIM_UNSUPPORTED);
  SimCapturePreviousPose;
  Inc(Ticks); Inc(ServerTickCounter); Inc(MainTickCounter);
  SimEventsSetTick(MainTickCounter); SimEventsSetReplay(Flags and 1 <> 0);
  for J := 1 to MAX_SPRITES do if Sprite[J].Active then NoClientUpdateTime[J] := 0;
  try
    try
      UpdateMovementFrame; Stage('tick');
    except
      on E: ESimEventOverflow do Exit(SIM_CAPACITY);
      on E: ENotSupportedException do Exit(SIM_UNSUPPORTED);
    end;
  finally
    SimEventsSetReplay(False);
  end;
  Result := MainTickCounter;
end;
function sim_events(Buffer: Pointer; Capacity: LongWord): LongInt;
begin
  if not Initialized then Exit(SIM_NOT_INITIALIZED);
  if (Buffer = nil) and (Capacity <> 0) then Exit(SIM_INVALID);
  Result := SimEventsRead(Buffer,Capacity);
end;
function sim_render_view: Pointer;
begin if not Initialized or not MapLoaded then Result := nil else Result := SimRenderView; end;
function sim_save_state(Buffer: Pointer; Capacity: LongWord): LongInt;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  Result := SimSaveState(Buffer,Capacity);
end;
function sim_load_state(Buffer: Pointer; Length: LongWord): LongInt;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  Result := SimLoadState(Buffer,Length);
end;
function sim_hash_state: QWord;
begin if not Initialized or not MapLoaded then Result := 0 else Result := SimHashState; end;
function sim_trace_state(Buffer: Pointer; Capacity: LongWord): LongInt;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  CurrentTick := MainTickCounter; TraceOpen := True;
  try
    if CurrentTick = 0 then OracleDump('initial',0) else OracleDump('tick',0);
  finally TraceOpen := False; end;
  Result := Length(SimTraceRow);
  if (Buffer = nil) and (Capacity = 0) then Exit;
  if Buffer = nil then Exit(SIM_INVALID);
  if Capacity < LongWord(Result) then Exit(SIM_CAPACITY);
  if Result <> 0 then Move(SimTraceRow[1],Buffer^,Result);
end;
function fx_step: LongInt;
begin Result := SIM_UNSUPPORTED; end;
function fx_render_view: LongInt;
begin Result := SIM_UNSUPPORTED; end;
end.
