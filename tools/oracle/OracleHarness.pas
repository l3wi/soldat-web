unit OracleHarness;

interface

procedure RunOracle;
procedure OracleDump(const Stage: string; Entity: Integer);

implementation

uses
  Classes, SysUtils, Math, fpjson, jsonparser, PhysFS,
  Anims, Constants, Cvar, Demo, Game, LogFile, Net, Parts, PolyMap, Server,
  ServerLoop, Sprites, Util, Vector, Weapons;

var
  Fixture: TJSONObject;
  TraceFile: Text;
  TraceOpen: Boolean = False;
  CurrentTick: Integer = 0;

function F32(Value: Single): TJSONObject;
var
  Bits: LongWord;
begin
  Move(Value, Bits, SizeOf(Bits));
  Result := TJSONObject.Create;
  Result.Add('bits', LowerCase(IntToHex(Bits, 8)));
  if IsNan(Value) then Result.Add('decimal', 'NaN')
  else if IsInfinite(Value) then
  begin
    if Value < 0 then Result.Add('decimal', '-Infinity')
    else Result.Add('decimal', 'Infinity');
  end
  else Result.Add('decimal', Double(Value));
end;

function V(const Value: TVector2): TJSONArray;
begin
  Result := TJSONArray.Create;
  Result.Add(F32(Value.X));
  Result.Add(F32(Value.Y));
end;

function Particle(const P: ParticleSystem; Index: Integer): TJSONObject;
begin
  Result := TJSONObject.Create;
  Result.Add('pos', V(P.Pos[Index]));
  Result.Add('oldpos', V(P.OldPos[Index]));
  Result.Add('velocity', V(P.Velocity[Index]));
  Result.Add('forces', V(P.Forces[Index]));
end;

function Animation(const A: TAnimation): TJSONObject;
begin
  Result := TJSONObject.Create;
  Result.Add('id', A.ID);
  Result.Add('frame', A.CurrFrame);
  Result.Add('count', A.Count);
end;

function Weapon(const W: TGun): TJSONObject;
begin
  Result := TJSONObject.Create;
  Result.Add('num', W.Num);
  Result.Add('ammo', W.AmmoCount);
  Result.Add('fireInterval', W.FireIntervalCount);
  Result.Add('fireIntervalPrev', W.FireIntervalPrev);
  Result.Add('fireIntervalReal', F32(W.FireIntervalReal));
  Result.Add('startup', W.StartUpTimeCount);
  Result.Add('reload', W.ReloadTimeCount);
  Result.Add('reloadPrev', W.ReloadTimePrev);
  Result.Add('reloadReal', F32(W.ReloadTimeReal));
end;

procedure Emit(Row: TJSONObject);
begin
  WriteLn(TraceFile, Row.AsJSON);
  Row.Free;
end;

procedure OracleDump(const Stage: string; Entity: Integer);
var
  Row, S, B, T: TJSONObject;
  Soldiers, Bullets, Things, Skeleton: TJSONArray;
  I, J: Integer;
begin
  if not TraceOpen then Exit;
  Row := TJSONObject.Create;
  Row.Add('type', 'state');
  Row.Add('tick', CurrentTick);
  Row.Add('stage', Stage);
  Row.Add('entity', Entity);
  Row.Add('randSeed', Int64(RandSeed));
  Row.Add('jetCapacity', Map.StartJet);
  Soldiers := TJSONArray.Create;
  Row.Add('sprites', Soldiers);
  for I := 1 to MAX_SPRITES do
    if Sprite[I].Active then
    begin
      S := TJSONObject.Create;
      Soldiers.Add(S);
      S.Add('id', I);
      S.Add('dead', Sprite[I].DeadMeat);
      S.Add('particle', Particle(SpriteParts, I));
      Skeleton := TJSONArray.Create;
      S.Add('skeleton', Skeleton);
      for J := 1 to 24 do
      begin
        B := TJSONObject.Create;
        B.Add('pos', V(Sprite[I].Skeleton.Pos[J]));
        B.Add('oldpos', V(Sprite[I].Skeleton.OldPos[J]));
        Skeleton.Add(B);
      end;
      S.Add('onGround', Sprite[I].OnGround);
      S.Add('onGroundPermanent', Sprite[I].OnGroundPermanent);
      S.Add('onGroundLastFrame', Sprite[I].OnGroundLastFrame);
      S.Add('position', Sprite[I].Position);
      S.Add('jetsCount', Sprite[I].JetsCount);
      S.Add('legs', Animation(Sprite[I].LegsAnimation));
      S.Add('body', Animation(Sprite[I].BodyAnimation));
      S.Add('direction', Sprite[I].Direction);
      S.Add('health', F32(Sprite[I].Health));
      S.Add('weapon', Weapon(Sprite[I].Weapon));
      S.Add('secondaryWeapon', Weapon(Sprite[I].SecondaryWeapon));
      S.Add('tertiaryWeapon', Weapon(Sprite[I].TertiaryWeapon));
    end;
  Bullets := TJSONArray.Create;
  Row.Add('bullets', Bullets);
  for I := 1 to MAX_BULLETS do
    if Game.Bullet[I].Active then
    begin
      B := Particle(BulletParts, I);
      B.Add('id', I);
      B.Add('style', Game.Bullet[I].Style);
      B.Add('timeout', Game.Bullet[I].TimeOut);
      Bullets.Add(B);
    end;
  Things := TJSONArray.Create;
  Row.Add('things', Things);
  for I := 1 to MAX_THINGS do
    if Thing[I].Active then
    begin
      T := TJSONObject.Create;
      T.Add('id', I);
      T.Add('style', Thing[I].Style);
      T.Add('timeout', Thing[I].TimeOut);
      Skeleton := TJSONArray.Create;
      T.Add('particles', Skeleton);
      for J := 1 to Thing[I].Skeleton.PartCount do
        Skeleton.Add(Particle(Thing[I].Skeleton, J));
      Things.Add(T);
    end;
  Emit(Row);
end;

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
  I, Slot: Integer;
begin
  for I := 1 to MAX_SPRITES do
    if Sprite[I].Active then
    begin
      Sprite[I].Control := Default(TControl);
      NoClientUpdateTime[I] := 0;
    end;
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
      Sprite[Slot].Control := ReadControl(Input.Objects['control']);
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
  I, Spawn, Slot, TickCount, Tick: Integer;
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
    Velocity := Default(TVector2);
    P := TPlayer.Create;
    P.Team := PlayerSpec.Integers['team'];
    P.ControlMethod := HUMAN;
    P.Name := 'oracle-' + IntToStr(I + 1);
    Slot := CreateSprite(Pos, Velocity, 1, I + 1, P, True);
    if Slot <> I + 1 then raise Exception.Create('Unexpected sprite slot');
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
