unit SimState;
{$mode delphi}
{$H+}
interface
uses Net;
type TSimInputHistory = array[1..MAX_PLAYERS] of Boolean;
var SimWasJumping, SimWasRunningLeft: TSimInputHistory;
procedure SimResetOriginalRNG(Seed: LongWord);
function SimSaveState(OutBuffer: Pointer; Capacity: LongWord): LongInt;
function SimLoadState(Buffer: Pointer; Length: LongWord): LongInt;
function SimHashState: QWord;
implementation
uses SysUtils, Math, Game, Parts, Anims, Sprites, Bullets, Things,
  Weapons, Vector, MapFile, PolyMap, Server, SimRender, SimEvents, PhysFS, NetworkServerSprite, Constants, SimAnimationContent, SimRandom;
const STATE_MAGIC = $31545353; MAX_STATE_BYTES = 32 * 1024 * 1024;
procedure SimResetOriginalRNG(Seed: LongWord);
begin
  ResetOriginalRNG(Seed);
end;
type
  EState = class(Exception);
  TCodec = object
    Data: PByte;
    Capacity, Offset: LongWord;
    Reading, Apply, Hashing: Boolean;
    Hash: QWord;
    EntityIndex: Integer;
    function Number(Value: QWord; Width: Integer): QWord;
    function Count(Value, Maximum: LongWord): LongWord;
    function B(var Value: Boolean): Boolean;
    function U(var Value: Byte; Maximum: Byte): Byte;
    function I(var Value: LongInt; Minimum, Maximum: LongInt): LongInt;
    function S(var Value: SmallInt; Minimum, Maximum: SmallInt): SmallInt;
    procedure Owner(var Value: Byte);
    procedure WeaponNumber(var Value: Byte);
    procedure C(var Value: Byte); overload;
    procedure C(var Value: ShortInt); overload;
    procedure C(var Value: Word); overload;
    procedure C(var Value: SmallInt); overload;
    procedure C(var Value: LongWord); overload;
    procedure C(var Value: LongInt); overload;
    procedure C(var Value: Boolean); overload;
    procedure C(var Value: Single); overload;
    procedure C(var Value: AnsiString); overload;
    procedure C(var Value: ShortString); overload;
    procedure V(var Value: TVector2);
    procedure Particle(var P: ParticleSystem);
    procedure Animation(var A: TAnimation);
    procedure Gun(var W: TGun);
    procedure Control(var X: TControl);
    procedure Background(var X: TBackgroundState; Live: Boolean = False);
    procedure Brain(var X: TBotData);
    procedure Player(P: TPlayer);
    procedure Soldier(var X: TSprite);
    procedure Projectile(var X: TBullet);
    procedure Polygon(var X: TMapPolygon);
    procedure ObjectThing(var X: TThing);
    procedure State;
  end;
procedure Fail;
begin raise EState.Create('Malformed simulation state'); end;
function TCodec.Number(Value: QWord; Width: Integer): QWord;
var J: Integer;
begin
  if (Offset > MAX_STATE_BYTES - LongWord(Width)) then Fail;
  if Reading then
  begin
    if (Offset > Capacity) or (LongWord(Width) > Capacity - Offset) then Fail;
    Result := 0;
    for J := 0 to Width - 1 do Result := Result or (QWord(Data[Offset+LongWord(J)]) shl (8*J));
  end
  else
  begin
    Result := Value;
    if Data <> nil then
    begin
      if (Offset > Capacity) or (LongWord(Width) > Capacity - Offset) then Fail;
      for J := 0 to Width - 1 do Data[Offset+LongWord(J)] := Byte(Value shr (8*J));
    end;
  end;
  if Hashing then
    for J := 0 to Width - 1 do
      Hash := (Hash xor Byte(Value shr (8*J))) * QWord($100000001B3);
  Inc(Offset, Width);
end;
function TCodec.Count(Value, Maximum: LongWord): LongWord;
begin Result := Number(Value, 4); if Result > Maximum then Fail; end;
function TCodec.B(var Value: Boolean): Boolean;
var X: QWord;
begin
  X := Number(Ord(Value), 1); if X > 1 then Fail;
  Result := X <> 0; if Reading and Apply then Value := Result;
end;
function TCodec.U(var Value: Byte; Maximum: Byte): Byte;
begin
  Result := Number(Value,1); if Result > Maximum then Fail;
  if Reading and Apply then Value := Result;
end;
function TCodec.I(var Value: LongInt; Minimum, Maximum: LongInt): LongInt;
begin
  Result := LongInt(LongWord(Number(LongWord(Value), 4)));
  if (Result < Minimum) or (Result > Maximum) then Fail;
  if Reading and Apply then Value := Result;
end;
procedure TCodec.C(var Value: Byte);
var X: Byte; begin X := Number(Value, 1); if Reading and Apply then Value := X; end;
procedure TCodec.C(var Value: ShortInt);
var X: ShortInt; begin X := ShortInt(Byte(Number(Byte(Value), 1))); if Reading and Apply then Value := X; end;
procedure TCodec.C(var Value: Word);
var X: Word; begin X := Number(Value, 2); if Reading and Apply then Value := X; end;
procedure TCodec.C(var Value: SmallInt);
var X: SmallInt; begin X := SmallInt(Word(Number(Word(Value), 2))); if Reading and Apply then Value := X; end;
procedure TCodec.C(var Value: LongWord);
var X: LongWord; begin X := Number(Value, 4); if Reading and Apply then Value := X; end;
procedure TCodec.C(var Value: LongInt);
var X: LongInt; begin X := LongInt(LongWord(Number(LongWord(Value), 4))); if Reading and Apply then Value := X; end;
procedure TCodec.C(var Value: Boolean);
begin B(Value); end;
procedure TCodec.C(var Value: Single);
var Bits: LongWord; X: Single;
begin
  Move(Value, Bits, 4); Bits := Number(Bits, 4); Move(Bits, X, 4);
  if IsNan(X) or IsInfinite(X) then Fail;
  if Reading and Apply then Value := X;
end;
procedure TCodec.C(var Value: AnsiString);
var N, J: LongWord; X: Byte;
begin
  N := Count(Length(Value), 65535);
  if Reading and Apply then SetLength(Value, N);
  for J := 1 to N do
  begin
    X := 0; if not Reading then X := Ord(Value[J]);
    X := Number(X, 1); if Reading and Apply then Value[J] := AnsiChar(X);
  end;
end;
procedure TCodec.C(var Value: ShortString);
var N, J: LongWord; X: Byte;
begin
  N := Count(Length(Value), 255);
  if Reading and Apply then SetLength(Value, N);
  for J := 1 to N do
  begin
    X := 0; if not Reading then X := Ord(Value[J]);
    X := Number(X, 1); if Reading and Apply then Value[J] := AnsiChar(X);
  end;
end;
procedure TCodec.V(var Value: TVector2);
begin C(Value.X); C(Value.Y); end;
function TCodec.S(var Value: SmallInt; Minimum, Maximum: SmallInt): SmallInt;
begin
  Result := SmallInt(Word(Number(Word(Value),2)));
  if (Result < Minimum) or (Result > Maximum) then Fail;
  if Reading and Apply then Value := Result;
end;
procedure TCodec.Owner(var Value: Byte);
var N: Byte;
begin
  N := Number(Value,1);
  if (N > MAX_PLAYERS) and (N <> 255) then Fail;
  if Reading and Apply then Value := N;
end;
procedure TCodec.WeaponNumber(var Value: Byte);
var N: Byte;
begin
  N := Number(Value,1);
  if not ((N <= 16) or (N = 30) or ((N >= 50) and (N <= 53)) or (N = 255)) then Fail;
  if Reading and Apply then Value := N;
end;
function NonzeroSingle(const Value: Single): Boolean; inline;
var Bits: LongWord;
begin Move(Value,Bits,4); Result := Bits <> 0; end;
function NonzeroVector(const Value: TVector2): Boolean; inline;
var Bits: QWord;
begin Move(Value,Bits,8); Result := Bits <> 0; end;
function ParticlePresent(const P: ParticleSystem; J: Integer): Boolean; inline;
begin
  Result := P.Active[J] or NonzeroVector(P.Pos[J]) or
    NonzeroVector(P.OldPos[J]) or NonzeroVector(P.Velocity[J]) or
    NonzeroVector(P.Forces[J]) or NonzeroSingle(P.OneOverMass[J]);
end;
function ConstraintPresent(const P: ParticleSystem; J: Integer): Boolean; inline;
begin
  Result := P.Constraints[J].Active or (P.Constraints[J].PartA <> 0) or
    (P.Constraints[J].PartB <> 0) or NonzeroSingle(P.Constraints[J].RestLength);
end;
var ZeroParticleBytes: array[0..NUM_PARTICLES*SizeOf(Constraint)-1] of Byte;
function EmptyParticleArrays(const P: ParticleSystem): Boolean; inline;
begin
  Result := CompareMem(@P.Active,@ZeroParticleBytes,SizeOf(P.Active)) and
    CompareMem(@P.Pos,@ZeroParticleBytes,SizeOf(P.Pos)) and
    CompareMem(@P.OldPos,@ZeroParticleBytes,SizeOf(P.OldPos)) and
    CompareMem(@P.Velocity,@ZeroParticleBytes,SizeOf(P.Velocity)) and
    CompareMem(@P.Forces,@ZeroParticleBytes,SizeOf(P.Forces)) and
    CompareMem(@P.OneOverMass,@ZeroParticleBytes,SizeOf(P.OneOverMass)) and
    CompareMem(@P.Constraints,@ZeroParticleBytes,SizeOf(P.Constraints));
end;
procedure TCodec.Particle(var P: ParticleSystem);
var J, K, A, Z, LastIndex: Integer; Entries: LongWord; ActiveConstraint: Boolean;
begin
  C(P.TimeStep); C(P.GravityMultiplier); C(P.VDamping); C(P.EDamping);
  I(P.PartCount,0,NUM_PARTICLES); I(P.ConstraintCount,0,NUM_PARTICLES);
  if not Reading and EmptyParticleArrays(P) then
  begin Number(0,4); Number(0,4); Exit; end;
  Entries := 0;
  if not Reading then
    for J := 1 to NUM_PARTICLES do if ParticlePresent(P,J) then Inc(Entries);
  Entries := Count(Entries,NUM_PARTICLES);
  if Reading and Apply then
  begin
    FillChar(P.Active,SizeOf(P.Active),0); FillChar(P.Pos,SizeOf(P.Pos),0);
    FillChar(P.OldPos,SizeOf(P.OldPos),0); FillChar(P.Velocity,SizeOf(P.Velocity),0);
    FillChar(P.Forces,SizeOf(P.Forces),0); FillChar(P.OneOverMass,SizeOf(P.OneOverMass),0);
  end;
  LastIndex := 0; K := 0;
  while LongWord(K) < Entries do
  begin
    if Reading then J := Number(0,2)
    else
    begin
      J := LastIndex+1;
      while not ParticlePresent(P,J) do Inc(J);
      Number(J,2);
    end;
    if (J <= LastIndex) or (J > NUM_PARTICLES) then Fail;
    LastIndex := J;
    C(P.Active[J]); V(P.Pos[J]); V(P.OldPos[J]); V(P.Velocity[J]); V(P.Forces[J]); C(P.OneOverMass[J]);
    Inc(K);
  end;
  Entries := 0;
  if not Reading then
    for J := 1 to NUM_PARTICLES do if ConstraintPresent(P,J) then Inc(Entries);
  Entries := Count(Entries,NUM_PARTICLES);
  if Reading and Apply then FillChar(P.Constraints,SizeOf(P.Constraints),0);
  LastIndex := 0; K := 0;
  while LongWord(K) < Entries do
  begin
    if Reading then J := Number(0,2)
    else
    begin
      J := LastIndex+1;
      while not ConstraintPresent(P,J) do Inc(J);
      Number(J,2);
    end;
    if (J <= LastIndex) or (J > NUM_PARTICLES) then Fail;
    LastIndex := J;
    ActiveConstraint := B(P.Constraints[J].Active);
    A := I(P.Constraints[J].PartA,0,NUM_PARTICLES);
    Z := I(P.Constraints[J].PartB,0,NUM_PARTICLES);
    C(P.Constraints[J].RestLength);
    if ActiveConstraint and ((A = 0) or (Z = 0)) then Fail;
    Inc(K);
  end;
end;
procedure TCodec.Animation(var A: TAnimation);
var ID, N, F, TemplateIndex: Integer; FramesHash: QWord;
begin
  ID := I(A.ID,0,43); N := I(A.NumFrames,0,MAX_FRAMES_INDEX);
  I(A.Speed,0,High(LongInt)); I(A.Count,0,High(LongInt));
  F := I(A.CurrFrame,0,MAX_FRAMES_INDEX); if F > N then Fail; C(A.Loop);
  if N = 0 then FramesHash := 0
  else
  begin
    if N <> SimAnimationFrameCount(ID) then Fail;
    FramesHash := SimAnimationFrameHash(ID);
  end;
  if Number(FramesHash,8) <> FramesHash then Fail;
  if Reading then
  begin
    TemplateIndex := SimAnimationTemplateIndex(A);
    if (TemplateIndex >= 0) and (TemplateIndex <> ID) then Fail;
    if Apply then SimRestoreAnimationFrames(A,ID,N);
  end;
end;
procedure TCodec.Gun(var W: TGun);
begin
  C(W.Ammo);
  C(W.AmmoCount);
  WeaponNumber(W.Num);
  C(W.MovementAcc);
  C(W.Bink);
  C(W.Recoil);
  C(W.FireInterval);
  C(W.FireIntervalPrev);
  C(W.FireIntervalCount);
  C(W.FireIntervalReal);
  C(W.StartUpTime);
  C(W.StartUpTimeCount);
  C(W.ReloadTime);
  C(W.ReloadTimePrev);
  C(W.ReloadTimeCount);
  C(W.ReloadTimeReal);
  C(W.TextureNum);
  C(W.ClipTextureNum);
  C(W.ClipReload);
  C(W.ClipInTime);
  C(W.ClipOutTime);
  C(W.Name);
  C(W.IniName);
  C(W.Speed);
  C(W.HitMultiply);
  C(W.BulletSpread);
  C(W.Push);
  C(W.InheritedVelocity);
  C(W.ModifierLegs);
  C(W.ModifierChest);
  C(W.ModifierHead);
  C(W.NoCollision);
  C(W.FireMode);
  C(W.Timeout);
  C(W.BulletStyle);
  C(W.FireStyle);
  C(W.BulletImageStyle);
end;
procedure TCodec.Control(var X: TControl);
begin
  C(X.Left);
  C(X.Right);
  C(X.Up);
  C(X.Down);
  C(X.Fire);
  C(X.Jetpack);
  C(X.ThrowNade);
  C(X.ChangeWeapon);
  C(X.ThrowWeapon);
  C(X.Reload);
  C(X.Prone);
  C(X.FlagThrow);
  C(X.MouseAimX);
  C(X.MouseAimY);
  C(X.MouseDist);
end;
procedure TCodec.Background(var X: TBackgroundState; Live: Boolean);
var Poly: SmallInt;
begin
  U(X.BackgroundStatus, 1);
  Poly := S(X.BackgroundPoly, -2, Map.PolyCount);
  if Live and (Poly = 0) then Fail;
  C(X.BackgroundTestResult);
end;
procedure TCodec.Brain(var X: TBotData);
begin
  C(X.FavWeapon);
  C(X.Friend);
  C(X.Accuracy);
  C(X.GrenadeFreq);
  C(X.DeadKill);
  C(X.WaypointTimeoutCounter);
  C(X.WaypointTimeout);
  C(X.ChatFreq);
  C(X.ChatKill);
  C(X.ChatDead);
  C(X.ChatLowHealth);
  C(X.ChatSeeEnemy);
  C(X.ChatWinning);
  C(X.PissedOff);
  C(X.PathNum);
  C(X.TargetNum);
  C(X.GoThing);
  C(X.CurrentWaypoint);
  C(X.NextWaypoint);
  C(X.OldWaypoint);
  C(X.WaypointTime);
  C(X.LastWaypoint);
  C(X.Use);
  C(X.OnePlaceCount);
  C(X.Camper);
  C(X.CampTimer);
  C(X.FallSave);
end;
procedure TCodec.Player(P: TPlayer);
begin
  C(P.Name);
  C(P.ShirtColor);
  C(P.PantsColor);
  C(P.SkinColor);
  C(P.HairColor);
  C(P.JetColor);
  C(P.Kills);
  C(P.Deaths);
  C(P.Flags);
  C(P.PingTicks);
  C(P.PingTicksB);
  C(P.PingTime);
  C(P.Ping);
  C(P.RealPing);
  C(P.ConnectionQuality);
  U(P.Team, 5);
  U(P.ControlMethod, HUMAN);
  C(P.Chain);
  C(P.HeadCap);
  C(P.HairStyle);
  U(P.SecWep, 3);
  U(P.Camera, MAX_SPRITES);
  C(P.Muted);
  U(P.SpriteNum, MAX_SPRITES);
  C(P.DemoPlayer);
  C(P.IP);
  C(P.Port);
  C(P.HWID);
  C(P.PlayTime);
  C(P.GameRequested);
  C(P.ChatWarnings);
  C(P.TKWarnings);
  C(P.ScoresPerSecond);
  C(P.GrabsPerSecond);
  C(P.GrabbedInBase);
  U(P.StandingPolyType, POLY_TYPE_BACKGROUND_TRANSITION);
  C(P.KnifeWarnings);
end;
procedure TCodec.Soldier(var X: TSprite);
var J, EntityNum: Integer; OwnPlayer, Live: Boolean; P: TPlayer;
begin
  Live := B(X.Active);
  C(X.DeadMeat);
  C(X.Dummy);
  C(X.Style);
  EntityNum := U(X.Num, MAX_SPRITES);
  if Live and (EntityNum <> EntityIndex) then Fail;
  C(X.Visible);
  C(X.OnGround);
  C(X.OnGroundForLaw);
  C(X.OnGroundLastFrame);
  C(X.OnGroundPermanent);
  S(X.Direction, -1, 1);
  S(X.OldDirection, -1, 1);
  C(X.Health);
  U(X.HoldedThing, MAX_THINGS);
  C(X.FlagGrabCooldown);
  C(X.AimDistCoef);
  C(X.Fired);
  C(X.Alpha);
  C(X.JetsCountReal);
  C(X.JetsCount);
  C(X.JetsCountPrev);
  C(X.WearHelmet);
  C(X.HasCigar);
  C(X.CanMercy);
  C(X.RespawnCounter);
  C(X.CeaseFireCounter);
  U(X.SelWeapon, TOTAL_WEAPONS);
  C(X.BonusStyle);
  C(X.BonusTime);
  C(X.MultiKillTime);
  C(X.MultiKills);
  C(X.Vest);
  C(X.IdleTime);
  C(X.IdleRandom);
  C(X.BurstCount);
  C(X.Position);
  C(X.OnFire);
  C(X.ColliderDistance);
  C(X.DeadCollideCount);
  C(X.DeadTime);
  U(X.Para, MAX_THINGS);
  U(X.Stat, MAX_THINGS);
  C(X.UseTime);
  C(X.HalfDead);
  C(X.LastWeaponHM);
  C(X.LastWeaponSpeed);
  U(X.LastWeaponStyle, BULLET_STYLE_M2);
  C(X.LastWeaponFire);
  C(X.LastWeaponReload);
  C(X.GrenadeCanThrow);
  C(X.Typing);
  C(X.AutoReloadWhenCanFire);
  C(X.CanAutoReloadSpas);
  C(X.HasPack);
  C(X.TargetX);
  C(X.TargetY);
  C(X.DontDrop);
  C(X.BulletCount);
  I(X.BulletCheckIndex, 0, BULLETCHECKARRAYSIZE);
  I(X.BulletCheckAmount, 0, BULLETCHECKARRAYSIZE);
  Particle(X.Skeleton); Animation(X.LegsAnimation); Animation(X.BodyAnimation);
  Control(X.Control); Gun(X.Weapon); Gun(X.SecondaryWeapon); Gun(X.TertiaryWeapon);
  Brain(X.Brain); Background(X.BGState,Live);
  for J := 0 to MAX_PUSHTICK do V(X.NextPush[J]);
  for J := 0 to BULLETCHECKARRAYSIZE do C(X.BulletCheck[J]);
  OwnPlayer := (X.Player <> nil) and (X.Player <> DummyPlayer);
  OwnPlayer := B(OwnPlayer);
  if Live and not OwnPlayer then Fail;
  if Reading and Apply then
  begin
    if OwnPlayer then
    begin
      if (X.Player = nil) or (X.Player = DummyPlayer) then X.Player := TPlayer.Create;
    end
    else
    begin
      if X.IsPlayerObjectOwner and (X.Player <> DummyPlayer) then X.Player.Free;
      X.Player := DummyPlayer;
    end;
    X.IsPlayerObjectOwner := OwnPlayer;
  end;
  P := X.Player; if P = nil then P := DummyPlayer;
  if OwnPlayer then Player(P);
end;
procedure TCodec.Projectile(var X: TBullet);
var N, J: LongWord; K, EntityNum: Integer; Hit, Live: Boolean; Collision: TThingCollision;
begin
  Live := B(X.Active);
  U(X.Style, BULLET_STYLE_M2);
  EntityNum := S(X.Num, 0, MAX_BULLETS);
  if Live and (EntityNum <> EntityIndex) then Fail;
  U(X.Owner, MAX_PLAYERS);
  WeaponNumber(X.OwnerWeapon);
  C(X.TimeOutReal);
  C(X.TimeOut);
  C(X.TimeOutPrev);
  C(X.HitMultiply);
  C(X.HitMultiplyPrev);
  C(X.Whizzed);
  C(X.OwnerPingTick);
  U(X.HitBody, MAX_PLAYERS);
  C(X.Tracking);
  C(X.ImageStyle);
  C(X.StartUpTime);
  C(X.RicochetCount);
  C(X.DegradeCount);
  C(X.Seed);
  C(X.DontCheat);
  V(X.VelocityPrev); V(X.HitSpot); V(X.Initial);
  N := Count(Length(X.ThingCollisions), MAX_STATE_BYTES div 5);
  if Reading and Apply then SetLength(X.ThingCollisions, N);
  for J := 1 to N do
  begin
    Collision := Default(TThingCollision);
    if not Reading then Collision := X.ThingCollisions[J-1];
    Collision.ThingNum := Number(Collision.ThingNum, 1);
    if (Collision.ThingNum < 1) or (Collision.ThingNum > MAX_THINGS) then Fail;
    Collision.CooldownEnd := LongInt(LongWord(Number(LongWord(Collision.CooldownEnd), 4)));
    if Reading and Apply then X.ThingCollisions[J-1] := Collision;
  end;
  for K := 1 to MAX_PLAYERS do
  begin
    Hit := K in X.SpriteCollisions; Hit := B(Hit);
    if Reading and Apply then
      if Hit then Include(X.SpriteCollisions,K) else Exclude(X.SpriteCollisions,K);
  end;
end;
procedure TCodec.Polygon(var X: TMapPolygon);
var J,K: Integer;
begin
  for J := 1 to 3 do
  begin
    C(X.Vertices[J].X); C(X.Vertices[J].Y); C(X.Vertices[J].Z); C(X.Vertices[J].RHW);
    for K := 0 to 3 do C(X.Vertices[J].Color[K]);
    C(X.Vertices[J].U); C(X.Vertices[J].V);
    C(X.Normals[J].X); C(X.Normals[J].Y); C(X.Normals[J].Z);
  end;
  U(X.PolyType, POLY_TYPE_BACKGROUND_TRANSITION); C(X.TextureIndex);
end;
procedure TCodec.ObjectThing(var X: TThing);
var J, EntityNum: Integer; Live: Boolean;
begin
  Live := B(X.Active);
  U(X.Style, OBJECT_STATIONARY_GUN);
  EntityNum := U(X.Num, MAX_THINGS);
  if Live and (EntityNum <> EntityIndex) then Fail;
  Owner(X.Owner);
  U(X.HoldingSprite, MAX_PLAYERS);
  C(X.AmmoCount);
  C(X.Radius);
  C(X.TimeOut);
  C(X.StaticType);
  C(X.Interest);
  C(X.CollideWithBullets);
  C(X.InBase);
  C(X.LastSpawn);
  U(X.Team, TEAM_SPECTATOR);
  Particle(X.Skeleton); Background(X.BGState,Live);
  for J := 1 to 4 do C(X.CollideCount[J]);
  for J := 1 to 2 do Polygon(X.Polys[J]);
end;
procedure TCodec.State;
var J,K: Integer; N, Identity, Seed, RandomWord, RandomUnion: LongWord; Name: AnsiString; Content: QWord; WasHashing: Boolean;
begin
  if Number(STATE_MAGIC,4) <> STATE_MAGIC then Fail;
  if Number(SIM_ABI_VERSION,4) <> SIM_ABI_VERSION then Fail;
  N := Number(Capacity,4); if Reading and (N <> Capacity) then Fail;
  Name := Map.MapInfo.Name;
  if Count(Length(Name),65535) <> LongWord(Length(Name)) then Fail;
  for J := 1 to Length(Name) do if Number(Ord(Name[J]),1) <> Ord(Name[J]) then Fail;
  Identity := Map.MapID; if Number(Identity,4) <> Identity then Fail;
  Identity := LoadedWMChecksum; if Number(Identity,4) <> Identity then Fail;
  Content := SimVFSHash;
  if Number(Content,8) <> Content then Fail;
  Seed := RandSeed; C(Seed); if Reading and Apply then RandSeed := Seed;
  C(OldRandSeed);
  RandomUnion := 0;
  for J := 0 to 3 do
  begin
    RandomWord := Number(RandomState[J],4);
    RandomUnion := RandomUnion or RandomWord;
    if Reading and Apply then RandomState[J] := RandomWord;
  end;
  if RandomUnion = 0 then Fail;
  C(Ticks);
  C(TicksPerSecond);
  C(Frames);
  C(FramesPerSecond);
  C(TickTime);
  C(TickTimeLast);
  C(GOALTICKS);
  C(BulletTimeTimer);
  C(Grav);
  C(AliveNum);
  C(SurvivalEndRound);
  C(WeaponsCleaned);
  C(CeaseFireTime);
  C(MapChangeTime);
  C(MapChangeCounter);
  C(MapChangeName);
  C(TimeLimitCounter);
  C(StartHealth);
  C(TimeLeftSec);
  C(TimeLeftMin);
  C(SinusCounter);
  C(MapIndex);
  C(VoteActive);
  C(VoteType);
  C(VoteTarget);
  C(VoteStarter);
  C(VoteReason);
  C(VoteTimeRemaining);
  C(VoteNumVotes);
  C(VoteMaxVotes);
  C(VoteKickReasonType);
  C(MainTickCounter);
  C(ServerTickCounter);
  C(PlayersNum);
  C(BotsNum);
  C(SpectatorsNum);
  C(PingTicksAdd);
  C(BonusFreq);
  C(LastPlayer);
  C(WaveRespawnTime);
  C(WaveRespawnCounter);
  C(WeaponsInGame);
  C(ShotDistance);
  C(ShotLife);
  C(ShotRicochet);
  C(HTFTime);
  C(SpriteMapColCount);
  C(DefaultWMChecksum);
  C(LoadedWMChecksum);
  C(Map.StartJet); C(Map.Grenades); C(Map.Medikits); C(Map.Weather); C(Map.Steps);
  for J := 0 to 5 do begin C(TeamAliveNum[J]); C(TeamScore[J]); end;
  for J := 0 to 4 do begin C(TeamPlayersNum[J]); C(TeamFlag[J]); end;
  for J := 1 to 4 do C(PlayersTeamNum[J]);
  for J := -1 to 15 do C(WeaponActive[J]);
  Player(DummyPlayer);
  Particle(SpriteParts); Particle(BulletParts);
  Particle(GostekSkeleton);
  Particle(BoxSkeleton);
  Particle(FlagSkeleton);
  Particle(ParaSkeleton);
  Particle(StatSkeleton);
  Particle(RifleSkeleton10);
  Particle(RifleSkeleton11);
  Particle(RifleSkeleton18);
  Particle(RifleSkeleton22);
  Particle(RifleSkeleton28);
  Particle(RifleSkeleton36);
  Particle(RifleSkeleton37);
  Particle(RifleSkeleton39);
  Particle(RifleSkeleton43);
  Particle(RifleSkeleton50);
  Particle(RifleSkeleton55);
  Animation(Run);
  Animation(Stand);
  Animation(RunBack);
  Animation(Jump);
  Animation(JumpSide);
  Animation(Roll);
  Animation(RollBack);
  Animation(Fall);
  Animation(Crouch);
  Animation(CrouchRun);
  Animation(CrouchRunBack);
  Animation(Reload);
  Animation(Throw);
  Animation(Recoil);
  Animation(Shotgun);
  Animation(Barret);
  Animation(SmallRecoil);
  Animation(AimRecoil);
  Animation(HandsUpRecoil);
  Animation(ClipIn);
  Animation(ClipOut);
  Animation(SlideBack);
  Animation(Change);
  Animation(ThrowWeapon);
  Animation(WeaponNone);
  Animation(Punch);
  Animation(ReloadBow);
  Animation(Melee);
  Animation(Cigar);
  Animation(Match);
  Animation(Smoke);
  Animation(Wipe);
  Animation(Groin);
  Animation(TakeOff);
  Animation(Victory);
  Animation(Piss);
  Animation(Mercy);
  Animation(Mercy2);
  Animation(Own);
  Animation(Prone);
  Animation(GetUp);
  Animation(ProneMove);
  Animation(Aim);
  Animation(HandsUpAim);
  for J := 1 to TOTAL_WEAPONS do begin Gun(Guns[J]); Gun(DefaultGuns[J]); end;
  for J := 1 to MAX_SPRITES do
  begin
    EntityIndex := J;
    Soldier(Sprite[J]); C(SimWasJumping[J]); C(SimWasRunningLeft[J]);
    for K := 0 to MAX_OLDPOS do V(OldSpritePos[J,K]);
    for K := 1 to MAIN_WEAPONS do C(WeaponSel[J,K]);
    C(SortedPlayers[J].Kills); C(SortedPlayers[J].Deaths); C(SortedPlayers[J].Flags);
    C(SortedPlayers[J].PlayerNum); C(SortedPlayers[J].Color);
    C(VoteHasVoted[J]); C(VoteCooldown[J]);
    C(NoClientUpdateTime[J]); C(MessagesASecNum[J]); C(FloodWarnings[J]); C(PingWarnings[J]);
    C(BulletTime[J]); C(GrenadeTime[J]); C(KnifeCan[J]);
    C(TKListKills[J]); C(BulletWarningCount[J]); C(CheatTag[J]);
    WasHashing := Hashing; Hashing := False;
    for K := 1 to 24 do V(SimPreviousPose[J,K]);
    Hashing := WasHashing;
  end;
  for J := 1 to MAX_BULLETS do begin EntityIndex := J; Projectile(Bullet[J]); end;
  for J := 1 to MAX_THINGS do begin EntityIndex := J; ObjectThing(Thing[J]); end;
  for J := 1 to MAX_SPRITES do
  begin
    C(Time_SpriteSnapshot[J]); C(Time_SpriteSnapshot_Mov[J]);
    C(OldSpriteSnapshotMsg[J].Header.ID); C(OldSpriteSnapshotMsg[J].Num);
    V(OldSpriteSnapshotMsg[J].Pos); V(OldSpriteSnapshotMsg[J].Velocity);
    C(OldSpriteSnapshotMsg[J].MouseAimX); C(OldSpriteSnapshotMsg[J].MouseAimY);
    C(OldSpriteSnapshotMsg[J].Position); C(OldSpriteSnapshotMsg[J].Keys16);
    C(OldSpriteSnapshotMsg[J].Look); C(OldSpriteSnapshotMsg[J].Vest);
    C(OldSpriteSnapshotMsg[J].Health); C(OldSpriteSnapshotMsg[J].AmmoCount);
    C(OldSpriteSnapshotMsg[J].GrenadeCount); C(OldSpriteSnapshotMsg[J].WeaponNum);
    C(OldSpriteSnapshotMsg[J].SecondaryWeaponNum); C(OldSpriteSnapshotMsg[J].ServerTicks);
    C(OldBulletSnapshotMsg[J].Header.ID); C(OldBulletSnapshotMsg[J].Owner);
    C(OldBulletSnapshotMsg[J].WeaponNum); V(OldBulletSnapshotMsg[J].Pos);
    V(OldBulletSnapshotMsg[J].Velocity); C(OldBulletSnapshotMsg[J].Seed);
    C(OldBulletSnapshotMsg[J].Forced);
    for K := 1 to MAX_SPRITES do
    begin
      C(OldMovementMsg[J,K].Header.ID); C(OldMovementMsg[J,K].Num);
      V(OldMovementMsg[J,K].Pos); V(OldMovementMsg[J,K].Velocity);
      C(OldMovementMsg[J,K].Keys16); C(OldMovementMsg[J,K].MouseAimX);
      C(OldMovementMsg[J,K].MouseAimY); C(OldMovementMsg[J,K].ServerTick);
      C(OldMouseAimMsg[J,K].Header.ID); C(OldMouseAimMsg[J,K].Num);
      C(OldMouseAimMsg[J,K].MouseAimX); C(OldMouseAimMsg[J,K].MouseAimY);
      C(OldWeaponsMsg[J,K].Header.ID); C(OldWeaponsMsg[J,K].Num);
      C(OldWeaponsMsg[J,K].WeaponNum); C(OldWeaponsMsg[J,K].SecondaryWeaponNum);
      C(OldWeaponsMsg[J,K].AmmoCount);
      C(OldHelmetMsg[J,K].Header.ID); C(OldHelmetMsg[J,K].Num);
      C(OldHelmetMsg[J,K].WearHelmet);
    end;
  end;
end;
function NewCodec(Buffer: Pointer; Size: LongWord; ReadMode, ApplyMode: Boolean): TCodec;
begin
  Result := Default(TCodec); Result.Data := Buffer; Result.Capacity := Size;
  Result.Reading := ReadMode; Result.Apply := ApplyMode;
end;
function SimSaveState(OutBuffer: Pointer; Capacity: LongWord): LongInt;
var Codec: TCodec; Required: LongWord;
begin
  Codec := NewCodec(nil,0,False,False);
  Codec.State; Required := Codec.Offset;
  if (OutBuffer = nil) and (Capacity = 0) then Exit(Required);
  if OutBuffer = nil then Exit(-1);
  if Capacity < Required then Exit(-5);
  Codec := NewCodec(OutBuffer,Required,False,False);
  Codec.State; Result := Codec.Offset;
end;
function SimLoadState(Buffer: Pointer; Length: LongWord): LongInt;
var Codec: TCodec;
begin
  if (Buffer = nil) or (Length < 12) or (Length > MAX_STATE_BYTES) then Exit(-6);
  if not SimAnimationContentValid then Exit(-6);
  Codec := NewCodec(Buffer,Length,True,False);
  try
    { A complete no-write pass validates every primitive, length and reference
      before any live state is changed. Both passes use the identical schema. }
    Codec.State; if Codec.Offset <> Length then Fail;
    Codec.Offset := 0; Codec.Apply := True; Codec.State;
    SimEventsReset;
    SimEventsSetTick(MainTickCounter);
    SimEventsSetReplay(False);
    Result := 0;
  except on E: EState do Result := -6; end;
end;
function SimHashState: QWord;
var Codec: TCodec;
begin
  { Snapshot byte length is a transport detail, not gameplay. Hash its header
    word as zero so hashing needs only one traversal of canonical fields. }
  Codec := NewCodec(nil,0,False,False);
  Codec.Hashing := True; Codec.Hash := QWord($CBF29CE484222325);
  Codec.State; Result := Codec.Hash;
end;
end.
