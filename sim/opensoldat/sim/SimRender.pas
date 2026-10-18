unit SimRender;
{$mode delphi}
interface
uses Vector, Net, Sprites;
const
  SIM_ABI_VERSION = $00010006;
  SIM_RENDER_STRIDE = 696;
  SIM_BULLET_STRIDE = 96;
  SIM_THING_STRIDE = 324;
  SIM_BULLETS_OFFSET = 32 + MAX_PLAYERS * SIM_RENDER_STRIDE;
  SIM_THINGS_OFFSET = SIM_BULLETS_OFFSET + 8 + MAX_BULLETS * SIM_BULLET_STRIDE;
  SIM_GLOBALS_OFFSET = SIM_THINGS_OFFSET + 8 + MAX_THINGS * SIM_THING_STRIDE;
  SIM_RENDER_BYTES = SIM_GLOBALS_OFFSET + 112;
type
  TSimPreviousPose = array[1..MAX_PLAYERS, 1..24] of TVector2;
var
  SimPreviousPose: TSimPreviousPose;
procedure SimCapturePreviousPose;
procedure SimResetRender;
function SimRenderView: Pointer;
implementation
uses Game, PolyMap, Server, Weapons, Constants, SimState;
var View: array[0..SIM_RENDER_BYTES-1] of Byte;
procedure U32(Offset: Integer; Value: LongWord);
begin
  View[Offset] := Byte(Value); View[Offset+1] := Byte(Value shr 8);
  View[Offset+2] := Byte(Value shr 16); View[Offset+3] := Byte(Value shr 24);
end;
procedure I32(Offset: Integer; Value: LongInt);
begin U32(Offset, LongWord(Value)); end;
procedure F32(Offset: Integer; Value: Single);
var Bits: LongWord;
begin Move(Value, Bits, 4); U32(Offset, Bits); end;
function PoseOffset(Slot:Integer):TVector2;
var J:Integer;
begin
  Result:=Default(TVector2);
  { SERVER CreateSprite deliberately publishes the untouched local template
    until its first pose update. Project only that exact template, without
    modifying authoritative skeletons or inferring an offset from one point. }
  if not Sprite[Slot].Active then Exit;
  for J:=1 to 24 do
    if (Sprite[Slot].Skeleton.Pos[J].X<>GostekSkeleton.Pos[J].X) or
      (Sprite[Slot].Skeleton.Pos[J].Y<>GostekSkeleton.Pos[J].Y) then Exit;
  Result:=SpriteParts.Pos[Slot];
end;
procedure SimCapturePreviousPose;
var I, J: Integer; Offset:TVector2;
begin
  for I := 1 to MAX_PLAYERS do begin
    Offset:=PoseOffset(I);
    for J := 1 to 24 do
      if Sprite[I].Active then begin
        SimPreviousPose[I,J].X:=Sprite[I].Skeleton.Pos[J].X+Offset.X;
        SimPreviousPose[I,J].Y:=Sprite[I].Skeleton.Pos[J].Y+Offset.Y;
      end else SimPreviousPose[I,J] := Default(TVector2);
  end;
end;
procedure SimResetRender;
begin FillChar(View, SizeOf(View), 0); SimCapturePreviousPose; end;
function SimRenderView: Pointer;
var I, J, Base, Count, EntityCount, NameLength: Integer; Flags,Mask: LongWord; Offset:TVector2;
begin
  FillChar(View, SizeOf(View), 0);
  Count := 0;
  for I := 1 to MAX_PLAYERS do
    if Sprite[I].Active then
    begin
      Inc(Count); Base := 32 + (I-1)*SIM_RENDER_STRIDE;
      Flags := 1;
      if Sprite[I].DeadMeat then Flags := Flags or 2;
      if Sprite[I].OnGround then Flags := Flags or 4;
      if Sprite[I].OnGroundPermanent then Flags := Flags or 8;
      if Sprite[I].Position = POS_CROUCH then Flags := Flags or 16;
      if Sprite[I].Position = POS_PRONE then Flags := Flags or 32;
      if SimBotOwned[I] then Flags:=Flags or 64;
      U32(Base, I); U32(Base+4, Flags);
      I32(Base+8, Sprite[I].Direction);
      I32(Base+12, Sprite[I].LegsAnimation.ID);
      I32(Base+16, Sprite[I].LegsAnimation.CurrFrame);
      I32(Base+20, Sprite[I].BodyAnimation.ID);
      I32(Base+24, Sprite[I].BodyAnimation.CurrFrame);
      I32(Base+28, Sprite[I].Control.MouseAimX);
      I32(Base+32, Sprite[I].Control.MouseAimY);
      I32(Base+36, Sprite[I].Weapon.Num);
      F32(Base+40, SpriteParts.Pos[I].X); F32(Base+44, SpriteParts.Pos[I].Y);
      F32(Base+48, Sprite[I].Health); I32(Base+52, Sprite[I].JetsCount);
      Offset:=PoseOffset(I);
      for J := 1 to 24 do
      begin
        F32(Base+56+(J-1)*8, SimPreviousPose[I,J].X);
        F32(Base+60+(J-1)*8, SimPreviousPose[I,J].Y);
        F32(Base+248+(J-1)*8, Sprite[I].Skeleton.Pos[J].X+Offset.X);
        F32(Base+252+(J-1)*8, Sprite[I].Skeleton.Pos[J].Y+Offset.Y);
      end;
      U32(Base+440,Sprite[I].Player.Team);
      U32(Base+444,Sprite[I].Weapon.AmmoCount or (LongWord(Sprite[I].TertiaryWeapon.AmmoCount) shl 8) or
        (LongWord(Sprite[I].Weapon.ReloadTimeCount) shl 16));
      U32(Base+448,Sprite[I].Fired);
      U32(Base+452,Sprite[I].Weapon.ClipTextureNum);
      U32(Base+456,Sprite[I].Weapon.ClipInTime); U32(Base+460,Sprite[I].Weapon.ClipOutTime);
      U32(Base+464,Sprite[I].SecondaryWeapon.Num); U32(Base+468,Sprite[I].TertiaryWeapon.Num);
      F32(Base+472,Sprite[I].Vest); U32(Base+476,Ord(Sprite[I].Control.Jetpack));
      U32(Base+480,Sprite[I].Alpha); U32(Base+484,Sprite[I].WearHelmet);
      U32(Base+488,Sprite[I].HasCigar); U32(Base+492,Sprite[I].Player.Chain);
      U32(Base+496,Sprite[I].Player.HeadCap); U32(Base+500,Sprite[I].Player.HairStyle);
      U32(Base+504,Sprite[I].Player.ShirtColor); U32(Base+508,Sprite[I].Player.PantsColor);
      U32(Base+512,Sprite[I].Player.SkinColor); U32(Base+516,Sprite[I].Player.HairColor);
      I32(Base+520,Sprite[I].CeaseFireCounter); U32(Base+524,Sprite[I].Visible);
      U32(Base+528,Sprite[I].Style); U32(Base+532,Ord(Sprite[I].Player.DemoPlayer));
      U32(Base+536,Sprite[I].Weapon.Ammo); U32(Base+540,Sprite[I].Weapon.ReloadTime);
      U32(Base+544,Sprite[I].Weapon.FireInterval); U32(Base+548,Sprite[I].Weapon.FireIntervalCount);
      I32(Base+552,Sprite[I].Player.Kills); I32(Base+556,Sprite[I].Player.Deaths);
      U32(Base+560,Sprite[I].Player.RealPing); U32(Base+564,Sprite[I].Player.Flags);
      U32(Base+568,Sprite[I].Player.ControlMethod);
      NameLength:=Length(Sprite[I].Player.Name);
      if NameLength>48 then begin
        NameLength:=48;
        { Never publish a partial UTF-8 codepoint at the fixed name boundary. }
        while (NameLength>0) and ((Ord(Sprite[I].Player.Name[NameLength+1]) and $C0)=$80) do Dec(NameLength);
      end;
      U32(Base+572,NameLength);
      for J:=1 to NameLength do View[Base+576+J-1]:=Ord(Sprite[I].Player.Name[J]);
      U32(Base+624,Sprite[I].Player.JetColor);
      I32(Base+628,WeaponNumToIndex(Sprite[I].Weapon.Num));
      I32(Base+632,WeaponNumToIndex(Sprite[I].SecondaryWeapon.Num));
      I32(Base+636,Sprite[I].Weapon.Bink);
      with Sprite[I].Control do
        Flags:=Ord(Left) or (Ord(Right) shl 1) or (Ord(Up) shl 2) or
          (Ord(Down) shl 3) or (Ord(Fire) shl 4) or (Ord(Jetpack) shl 5) or
          (Ord(ThrowNade) shl 6) or (Ord(ChangeWeapon) shl 7) or
          (Ord(ThrowWeapon) shl 8) or (Ord(Reload) shl 9) or
          (Ord(Prone) shl 10) or (Ord(FlagThrow) shl 11);
      U32(Base+640,Flags);I32(Base+644,Sprite[I].Control.MouseDist);
      I32(Base+648,Sprite[I].Brain.CurrentWaypoint);
      I32(Base+652,Sprite[I].Brain.NextWaypoint);
      Mask:=0;
      for J:=1 to MAIN_WEAPONS do
        if SimWeaponAvailable(I,J) then Mask:=Mask or (LongWord(1) shl (J-1));
      U32(Base+656,Mask);U32(Base+660,Ord(SimLimboAvailable[I]));
      I32(Base+664,Sprite[I].RespawnCounter);U32(Base+668,Sprite[I].BonusStyle);
      I32(Base+672,Sprite[I].BonusTime);U32(Base+676,Sprite[I].MultiKills);
      F32(Base+680,Sprite[I].AimDistCoef);I32(Base+684,Sprite[I].Position);
      Mask:=0;
      for J:=1 to MAX_PLAYERS do
        if not sv_realisticmode.Value or (SimVisibility[J,I]>0) then
          Mask:=Mask or (LongWord(1) shl (J-1));
      U32(Base+688,Mask);
      Mask:=0;
      for J:=1 to MAX_PLAYERS do
        if not sv_realisticmode.Value or (SimVisibility[J,I]>40) then
          Mask:=Mask or (LongWord(1) shl (J-1));
      U32(Base+692,Mask);
    end;
  U32(0, SIM_ABI_VERSION); U32(4, MainTickCounter); U32(8, Count);
  U32(12, MAX_PLAYERS); U32(16, SIM_RENDER_STRIDE);
  U32(20, SIM_BULLETS_OFFSET); U32(24, SIM_THINGS_OFFSET); U32(28, SIM_RENDER_BYTES);
  EntityCount := 0;
  for I := 1 to MAX_BULLETS do if Bullet[I].Active then
  begin
    Base := SIM_BULLETS_OFFSET + 8 + EntityCount*SIM_BULLET_STRIDE;
    U32(Base,I); U32(Base+4,Bullet[I].Style);
    F32(Base+8,BulletParts.Pos[I].X); F32(Base+12,BulletParts.Pos[I].Y);
    F32(Base+16,BulletParts.OldPos[I].X); F32(Base+20,BulletParts.OldPos[I].Y);
    U32(Base+24,Bullet[I].Owner); U32(Base+28,Bullet[I].OwnerWeapon);
    F32(Base+32,BulletParts.Velocity[I].X); F32(Base+36,BulletParts.Velocity[I].Y);
    I32(Base+40,Bullet[I].TimeOut); U32(Base+44,Bullet[I].ImageStyle);
    F32(Base+48,Bullet[I].VelocityPrev.X); F32(Base+52,Bullet[I].VelocityPrev.Y);
    F32(Base+56,Bullet[I].HitMultiply); F32(Base+60,Bullet[I].HitMultiplyPrev);
    I32(Base+64,Bullet[I].TimeOutPrev);
    F32(Base+68,Bullet[I].Initial.X); F32(Base+72,Bullet[I].Initial.Y);
    U32(Base+76,Bullet[I].HitBody);
    { PingAdd is client-network extrapolation, absent from the server simulation.
      Its unavailable bit distinguishes the zero storage from sampled state. }
    U32(Base+88,Ord(Bullet[I].Active)); U32(Base+92,1);
    Inc(EntityCount);
  end;
  U32(SIM_BULLETS_OFFSET,EntityCount); U32(SIM_BULLETS_OFFSET+4,SIM_BULLET_STRIDE);
  EntityCount := 0;
  for I := 1 to MAX_THINGS do if Thing[I].Active then
  begin
    Base := SIM_THINGS_OFFSET + 8 + EntityCount*SIM_THING_STRIDE;
    U32(Base,I); U32(Base+4,Thing[I].Style);
    F32(Base+8,Thing[I].Skeleton.Pos[1].X); F32(Base+12,Thing[I].Skeleton.Pos[1].Y);
    F32(Base+16,Thing[I].Skeleton.OldPos[1].X); F32(Base+20,Thing[I].Skeleton.OldPos[1].Y);
    U32(Base+24,Thing[I].Owner); U32(Base+28,Thing[I].AmmoCount);
    U32(Base+32,Thing[I].HoldingSprite);
    Flags := Ord(Thing[I].StaticType) or (Ord(Thing[I].InBase) shl 1);
    U32(Base+36,Flags); U32(Base+40,Thing[I].Skeleton.PartCount);
    for J := 1 to 16 do
    begin
      F32(Base+48+(J-1)*16,Thing[I].Skeleton.Pos[J].X);
      F32(Base+52+(J-1)*16,Thing[I].Skeleton.Pos[J].Y);
      F32(Base+56+(J-1)*16,Thing[I].Skeleton.OldPos[J].X);
      F32(Base+60+(J-1)*16,Thing[I].Skeleton.OldPos[J].Y);
    end;
    I32(Base+304,Thing[I].TimeOut); I32(Base+308,Thing[I].Interest);
    { Original NetworkClientThing snapshots tint from Owner.Player.ShirtColor.
      Project that source value without serializing client-only color state. }
    J:=Thing[I].Owner;
    if (Thing[I].Style=OBJECT_PARACHUTE) and (J>0) and (J<=MAX_PLAYERS) then
    begin
      U32(Base+312,Sprite[J].Player.ShirtColor); U32(Base+316,1);
    end;
    U32(Base+320,Thing[I].CreationFacing);
    Inc(EntityCount);
  end;
  U32(SIM_THINGS_OFFSET,EntityCount); U32(SIM_THINGS_OFFSET+4,SIM_THING_STRIDE);
  for J:=0 to 5 do I32(SIM_GLOBALS_OFFSET+J*4,TeamScore[J]);
  I32(SIM_GLOBALS_OFFSET+24,StartHealth); I32(SIM_GLOBALS_OFFSET+28,Map.StartJet);
  I32(SIM_GLOBALS_OFFSET+32,sv_gamemode.Value);I32(SIM_GLOBALS_OFFSET+36,SimScoreLimit);
  I32(SIM_GLOBALS_OFFSET+40,CeaseFireTime);
  I32(SIM_GLOBALS_OFFSET+44,SimTimeLimitTicks);I32(SIM_GLOBALS_OFFSET+48,TimeLimitCounter);
  I32(SIM_GLOBALS_OFFSET+52,MapChangeCounter);
  if SimRoundReady then I32(SIM_GLOBALS_OFFSET+56,2)
  else if MapChangeCounter>=0 then I32(SIM_GLOBALS_OFFSET+56,1);
  U32(SIM_GLOBALS_OFFSET+60,SimRoundEpoch);
  U32(SIM_GLOBALS_OFFSET+64,Ord(sv_realisticmode.Value));
  U32(SIM_GLOBALS_OFFSET+68,Ord(sv_survivalmode.Value));
  U32(SIM_GLOBALS_OFFSET+72,Ord(sv_advancemode.Value));
  U32(SIM_GLOBALS_OFFSET+76,Ord(GOALTICKS<>DEFAULT_GOALTICKS));
  F32(SIM_GLOBALS_OFFSET+80,GOALTICKS/DEFAULT_GOALTICKS);
  U32(SIM_GLOBALS_OFFSET+84,Ord(sv_sniperline.Value));
  U32(SIM_GLOBALS_OFFSET+88,Ord(sv_friendlyfire.Value));
  Mask:=0;
  for J:=1 to MAIN_WEAPONS do
    if WeaponActive[J]=1 then Mask:=Mask or (LongWord(1) shl (J-1));
  U32(SIM_GLOBALS_OFFSET+92,Mask);
  U32(SIM_GLOBALS_OFFSET+96,Ord(SurvivalEndRound));
  I32(SIM_GLOBALS_OFFSET+100,sv_advancemode_amount.Value);
  I32(SIM_GLOBALS_OFFSET+104,sv_bonus_frequency.Value);
  I32(SIM_GLOBALS_OFFSET+108,BulletTimeTimer);
  Result := @View[0];
end;
end.
