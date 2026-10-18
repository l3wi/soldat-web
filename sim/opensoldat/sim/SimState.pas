unit SimState;
{$mode delphi}
{$H+}
interface
uses Net;
type TSimInputHistory = array[1..MAX_PLAYERS] of Boolean;
var SimWasJumping, SimWasRunningLeft: TSimInputHistory;
var SimChosenPrimary,SimChosenSecondary:array[1..MAX_PLAYERS] of Byte;
var SimLimboAvailable,SimBotOwned:TSimInputHistory;
var SimOriginalWorld:Boolean=True;
var SimTimeLimitTicks,SimScoreLimit:LongInt;
var SimRoundEpoch:LongWord;
var SimRoundReady:Boolean;
var SimCustomShirt:array[1..MAX_PLAYERS] of LongWord;
var SimVisibility:array[1..MAX_PLAYERS,1..MAX_PLAYERS] of Byte;
function SimWeaponAvailable(Slot,Index:Integer):Boolean;
procedure SimApplyLoadout(Slot:Integer);
{ Every ABI entry point that can mutate gameplay or serialized content must
  invalidate before doing any work, including paths that can fail partway. }
procedure SimInvalidateState;
procedure SimResetOriginalRNG(Seed: LongWord);
function SimSaveState(OutBuffer: Pointer; Capacity: LongWord): LongInt;
function SimLoadState(Buffer: Pointer; Length: LongWord): LongInt;
function SimHashState: QWord;
implementation
uses SysUtils, Math, Game, Parts, Anims, Sprites, Bullets, Things,
  Weapons, Vector, MapFile, PolyMap, Server, SimRender, SimEvents, PhysFS, NetworkServerSprite, Constants, SimAnimationContent, SimRandom;
const STATE_MAGIC = $31545353; STATE_VERSION = $00010006; MAX_STATE_BYTES = 32 * 1024 * 1024;
function SimWeaponAvailable(Slot,Index:Integer):Boolean;
begin
  Result:=(Index>=1) and (Index<=MAIN_WEAPONS);
  if Result then Result:=(WeaponActive[Index]=1) and
    ((Index>PRIMARY_WEAPONS) or not sv_advancemode.Value or (WeaponSel[Slot,Index]=1));
end;
procedure SimApplyLoadout(Slot:Integer);
var Index:Integer;
begin
  Index:=WeaponNumToIndex(SimChosenPrimary[Slot]);
  if SimWeaponAvailable(Slot,Index) then begin
    Sprite[Slot].SelWeapon:=SimChosenPrimary[Slot];
    Sprite[Slot].ApplyWeaponByNum(SimChosenPrimary[Slot],1);
  end else Sprite[Slot].ApplyWeaponByNum(NOWEAPON_NUM,1);
  Index:=WeaponNumToIndex(SimChosenSecondary[Slot]);
  if SimWeaponAvailable(Slot,Index) then begin
    Sprite[Slot].Player.SecWep:=Index-COLT;
    Sprite[Slot].ApplyWeaponByNum(SimChosenSecondary[Slot],2);
  end else Sprite[Slot].ApplyWeaponByNum(NOWEAPON_NUM,2);
  Index:=WeaponNumToIndex(SimChosenPrimary[Slot]);
  if sv_advancemode.Value and (Index>=1) and (Index<=PRIMARY_WEAPONS) and
    not SimWeaponAvailable(Slot,Index) then begin
    Sprite[Slot].Weapon:=Sprite[Slot].SecondaryWeapon;
    Sprite[Slot].SecondaryWeapon:=Guns[NOWEAPON];
  end;
end;
procedure SimResetOriginalRNG(Seed: LongWord);
begin
  SimInvalidateState;
  ResetOriginalRNG(Seed);
end;
type
  EState = class(Exception);
  EStateCapacity = class(EState);
  TCodec = object
    Data: PByte;
    Capacity, Offset: LongWord;
    Reading, Apply: Boolean;
    PoseStart, PoseEnd: array[1..MAX_SPRITES] of LongWord;
    EntityIndex: Integer;
    function Number(Value: QWord; Width: Integer): QWord; inline;
    procedure Bytes(Value: Pointer; Size: LongWord);
    function Count(Value, Maximum: LongWord): LongWord; inline;
    function B(var Value: Boolean): Boolean; inline;
    function U(var Value: Byte; Maximum: Byte): Byte; inline;
    function I(var Value: LongInt; Minimum, Maximum: LongInt): LongInt; inline;
    function S(var Value: SmallInt; Minimum, Maximum: SmallInt): SmallInt; inline;
    procedure Owner(var Value: Byte);
    procedure WeaponNumber(var Value: Byte);
    procedure C(var Value: Byte); overload; inline;
    procedure C(var Value: ShortInt); overload; inline;
    procedure C(var Value: Word); overload; inline;
    procedure C(var Value: SmallInt); overload; inline;
    procedure C(var Value: LongWord); overload; inline;
    procedure C(var Value: LongInt); overload; inline;
    procedure C(var Value: Boolean); overload; inline;
    procedure C(var Value: Single); overload; inline;
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
var P: PByte;
{$IFNDEF ENDIAN_LITTLE}
  J: Integer;
{$ENDIF}
begin
  if Offset > MAX_STATE_BYTES - LongWord(Width) then Fail;
  if Reading or (Data <> nil) then
  begin
    if (Offset > Capacity) or (LongWord(Width) > Capacity - Offset) then
    begin
      if Reading then Fail;
      raise EStateCapacity.Create('Simulation state buffer is full');
    end;
    P := @Data[Offset];
  end
  else P := nil;
  Result := Value;
  {$IFDEF ENDIAN_LITTLE}
  { The wire format is explicitly little endian, not a native record dump.
    Fixed-width unaligned loads/stores avoid a byte loop for every scalar. }
  if Reading then
    case Width of
      1: Result := P^;
      2: Result := PWord(P)^;
      4: Result := PLongWord(P)^;
      8: Result := PQWord(P)^;
    else Fail;
    end
  else if P <> nil then
    case Width of
      1: P^ := Byte(Value);
      2: PWord(P)^ := Word(Value);
      4: PLongWord(P)^ := LongWord(Value);
      8: PQWord(P)^ := Value;
    else Fail;
    end;
  {$ELSE}
  if Reading then
  begin
    Result := 0;
    for J := 0 to Width - 1 do Result := Result or (QWord(P[J]) shl (8*J));
  end
  else if P <> nil then
    for J := 0 to Width - 1 do P[J] := Byte(Value shr (8*J));
  {$ENDIF}
  Inc(Offset, Width);
end;
procedure TCodec.Bytes(Value: Pointer; Size: LongWord);
begin
  if (Size > MAX_STATE_BYTES) or (Offset > MAX_STATE_BYTES - Size) then Fail;
  if (Offset > Capacity) or (Size > Capacity - Offset) then
  begin
    if Reading then Fail;
    raise EStateCapacity.Create('Simulation state buffer is full');
  end;
  if Reading then
  begin
    if Apply and (Size <> 0) then Move(Data[Offset],Value^,Size);
  end
  else if Size <> 0 then Move(Value^,Data[Offset],Size);
  Inc(Offset,Size);
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
  Move(Value, Bits, 4); Bits := Number(Bits, 4);
  { The exponent test rejects exactly all NaNs and infinities, without RTL
    floating-point helper calls for each serialized coordinate. }
  if (Bits and $7F800000) = $7F800000 then Fail;
  if Reading and Apply then begin Move(Bits, X, 4); Value := X; end;
end;
procedure TCodec.C(var Value: AnsiString);
var N: LongWord;
begin
  N := Count(Length(Value), 65535);
  if Reading and Apply then SetLength(Value, N);
  if N <> 0 then Bytes(Pointer(Value),N);
end;
procedure TCodec.C(var Value: ShortString);
var N: LongWord;
begin
  N := Count(Length(Value), 255);
  if Reading and Apply then SetLength(Value, N);
  if N <> 0 then Bytes(@Value[1],N);
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
function ZeroBytes(Data: PByte; Size: LongWord): Boolean;
begin
  { Inactive skeletons dominate snapshot scanning. Compare words directly
    against zero rather than calling the byte-oriented RTL memory comparer. }
  while Size >= 32 do
  begin
    if (PQWord(Data)^ or PQWord(@Data[8])^ or
        PQWord(@Data[16])^ or PQWord(@Data[24])^) <> 0 then Exit(False);
    Inc(Data,32); Dec(Size,32);
  end;
  while Size >= 8 do
  begin
    if PQWord(Data)^ <> 0 then Exit(False);
    Inc(Data,8); Dec(Size,8);
  end;
  while Size <> 0 do
  begin
    if Data^ <> 0 then Exit(False);
    Inc(Data); Dec(Size);
  end;
  Result := True;
end;
function EmptyParticleArrays(const P: ParticleSystem): Boolean; inline;
begin
  Result := ZeroBytes(@P.Active,SizeOf(P.Active)) and
    ZeroBytes(@P.Pos,SizeOf(P.Pos)) and
    ZeroBytes(@P.OldPos,SizeOf(P.OldPos)) and
    ZeroBytes(@P.Velocity,SizeOf(P.Velocity)) and
    ZeroBytes(@P.Forces,SizeOf(P.Forces)) and
    ZeroBytes(@P.OneOverMass,SizeOf(P.OneOverMass)) and
    ZeroBytes(@P.Constraints,SizeOf(P.Constraints));
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
  U(P.ControlMethod, BOT);
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
  U(X.CreationFacing,1);
end;
procedure TCodec.State;
var J,K: Integer; N, Identity, Seed, RandomWord, RandomUnion: LongWord; Name: AnsiString; Content: QWord;
begin
  if Number(STATE_MAGIC,4) <> STATE_MAGIC then Fail;
  if Number(STATE_VERSION,4) <> STATE_VERSION then Fail;
  { Encode zero until the final length is known. Gameplay hashing has always
    represented this transport-only header word as zero. }
  N := Number(0,4); if Reading and (N <> Capacity) then Fail;
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
  if Number(Ord(KeyedEnabled),1)<>Ord(KeyedEnabled) then Fail;
  if Number(MatchSeed,8)<>MatchSeed then Fail;
  if Number(sv_gamemode.Value,1)<>QWord(sv_gamemode.Value) then Fail;
  if Number(bots_difficulty.Value,2)<>QWord(bots_difficulty.Value) then Fail;
  if Number(Ord(SimOriginalWorld),1)<>Ord(SimOriginalWorld) then Fail;
  if Number(Ord(sv_stationaryguns.Value),1)<>Ord(sv_stationaryguns.Value) then Fail;
  { Immutable rules must match the initialized receiver, not silently inherit
    local defaults on rollback or across an authoritative full-state install. }
  if Number(Ord(sv_realisticmode.Value),1)<>Ord(sv_realisticmode.Value) then Fail;
  if Number(Ord(sv_survivalmode.Value),1)<>Ord(sv_survivalmode.Value) then Fail;
  if Number(Ord(sv_advancemode.Value),1)<>Ord(sv_advancemode.Value) then Fail;
  if Number(sv_advancemode_amount.Value,4)<>QWord(sv_advancemode_amount.Value) then Fail;
  if Number(Ord(sv_bullettime.Value),1)<>Ord(sv_bullettime.Value) then Fail;
  if Number(Ord(sv_friendlyfire.Value),1)<>Ord(sv_friendlyfire.Value) then Fail;
  if Number(Ord(sv_balanceteams.Value),1)<>Ord(sv_balanceteams.Value) then Fail;
  if Number(Ord(sv_sniperline.Value),1)<>Ord(sv_sniperline.Value) then Fail;
  if Number(sv_bonus_frequency.Value,1)<>QWord(sv_bonus_frequency.Value) then Fail;
  if Number(Ord(sv_bonus_flamer.Value),1)<>Ord(sv_bonus_flamer.Value) then Fail;
  if Number(Ord(sv_bonus_predator.Value),1)<>Ord(sv_bonus_predator.Value) then Fail;
  if Number(Ord(sv_bonus_berserker.Value),1)<>Ord(sv_bonus_berserker.Value) then Fail;
  if Number(Ord(sv_bonus_vest.Value),1)<>Ord(sv_bonus_vest.Value) then Fail;
  if Number(Ord(sv_bonus_cluster.Value),1)<>Ord(sv_bonus_cluster.Value) then Fail;
  if Number(SimTimeLimitTicks,4)<>QWord(SimTimeLimitTicks) then Fail;
  if Number(SimScoreLimit,4)<>QWord(SimScoreLimit) then Fail;
  for J:=1 to MAIN_WEAPONS do
    if Number(WeaponActive[J],1)<>WeaponActive[J] then Fail;
  C(SimRoundEpoch);B(SimRoundReady);
  for J:=1 to MAX_PLAYERS do begin
    C(SimCustomShirt[J]);
    for K:=1 to MAX_PLAYERS do U(SimVisibility[J,K],45);
  end;
  Content:=Number(OtherCounter,8);if Reading and Apply then OtherCounter:=Content;
  Content:=Number(AISeed,8);if Reading and Apply then AISeed:=Content;
  for J:=0 to 32 do begin C(ShotCounters[J]);C(EventCounters[J]);end;
  for J:=1 to MAX_PLAYERS do begin WeaponNumber(SimChosenPrimary[J]);WeaponNumber(SimChosenSecondary[J]);end;
  for J:=1 to MAX_PLAYERS do begin B(SimLimboAvailable[J]);B(SimBotOwned[J]);end;
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
    PoseStart[J] := Offset;
    for K := 1 to 24 do V(SimPreviousPose[J,K]);
    PoseEnd[J] := Offset;
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
const INITIAL_STATE_CAPACITY = 256 * 1024;
var
  EncodedState: array of Byte;
  EncodedLength: LongWord;
  EncodedHash: QWord;
  EncodedValid: Boolean = False;
procedure SimInvalidateState;
begin
  EncodedValid := False;
end;
function HashBytes(Hash: QWord; Data: PByte; Size: LongWord): QWord;
begin
  { One tight traversal of encoded bytes; no scalar codec calls or shifts.
    Unroll the dependency chain only to remove loop/addressing overhead. }
  while Size >= 8 do
  begin
    Hash := (Hash xor Data[0]) * QWord($100000001B3);
    Hash := (Hash xor Data[1]) * QWord($100000001B3);
    Hash := (Hash xor Data[2]) * QWord($100000001B3);
    Hash := (Hash xor Data[3]) * QWord($100000001B3);
    Hash := (Hash xor Data[4]) * QWord($100000001B3);
    Hash := (Hash xor Data[5]) * QWord($100000001B3);
    Hash := (Hash xor Data[6]) * QWord($100000001B3);
    Hash := (Hash xor Data[7]) * QWord($100000001B3);
    Inc(Data,8); Dec(Size,8);
  end;
  while Size <> 0 do
  begin
    Hash := (Hash xor Data^) * QWord($100000001B3);
    Inc(Data); Dec(Size);
  end;
  Result := Hash;
end;
procedure EncodeState;
var Codec: TCodec; J: Integer; Start, NewCapacity: LongWord;
begin
  if EncodedValid then Exit;
  if Length(EncodedState) = 0 then SetLength(EncodedState,INITIAL_STATE_CAPACITY);
  repeat
    Codec := NewCodec(@EncodedState[0],Length(EncodedState),False,False);
    try
      Codec.State;
      Break;
    except
      on E: EStateCapacity do
      begin
        { Only growth allocates; ordinary save/hash calls reuse the buffer. }
        NewCapacity := Length(EncodedState);
        if NewCapacity = MAX_STATE_BYTES then Fail;
        NewCapacity := Min(NewCapacity * 2,MAX_STATE_BYTES);
        SetLength(EncodedState,NewCapacity);
      end;
    end;
  until False;
  EncodedLength := Codec.Offset;
  EncodedHash := QWord($CBF29CE484222325);
  Start := 0;
  for J := 1 to MAX_SPRITES do
  begin
    EncodedHash := HashBytes(EncodedHash,@EncodedState[Start],Codec.PoseStart[J]-Start);
    Start := Codec.PoseEnd[J];
  end;
  EncodedHash := HashBytes(EncodedHash,@EncodedState[Start],EncodedLength-Start);
  { The copied snapshot retains the exact original transport length. Pose
    bytes remain serialized and validated, but excluded from gameplay hash. }
  Codec.Offset := 8; Codec.Number(EncodedLength,4);
  EncodedValid := True;
end;
function SimSaveState(OutBuffer: Pointer; Capacity: LongWord): LongInt;
begin
  EncodeState;
  if (OutBuffer = nil) and (Capacity = 0) then Exit(EncodedLength);
  if OutBuffer = nil then Exit(-1);
  if Capacity < EncodedLength then Exit(-5);
  Move(EncodedState[0],OutBuffer^,EncodedLength);
  Result := EncodedLength;
end;
function SimLoadState(Buffer: Pointer; Length: LongWord): LongInt;
var Codec: TCodec;
begin
  SimInvalidateState;
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
begin
  EncodeState;
  Result := EncodedHash;
end;
end.
