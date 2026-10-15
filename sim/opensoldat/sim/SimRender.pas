unit SimRender;
{$mode delphi}
interface
uses Vector, Net, Sprites;
const
  SIM_ABI_VERSION = $00010002;
  SIM_RENDER_STRIDE = 448;
  SIM_BULLET_STRIDE = 48;
  SIM_THING_STRIDE = 304;
  SIM_BULLETS_OFFSET = 32 + MAX_PLAYERS * SIM_RENDER_STRIDE;
  SIM_THINGS_OFFSET = SIM_BULLETS_OFFSET + 8 + MAX_BULLETS * SIM_BULLET_STRIDE;
  SIM_RENDER_BYTES = SIM_THINGS_OFFSET + 8 + MAX_THINGS * SIM_THING_STRIDE;
type
  TSimPreviousPose = array[1..MAX_PLAYERS, 1..24] of TVector2;
var
  SimPreviousPose: TSimPreviousPose;
procedure SimCapturePreviousPose;
procedure SimResetRender;
function SimRenderView: Pointer;
implementation
uses Game;
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
var I, J, Base, Count, EntityCount: Integer; Flags: LongWord; Offset:TVector2;
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
    Inc(EntityCount);
  end;
  U32(SIM_THINGS_OFFSET,EntityCount); U32(SIM_THINGS_OFFSET+4,SIM_THING_STRIDE);
  Result := @View[0];
end;
end.
