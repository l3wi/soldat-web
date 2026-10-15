unit SimAnimationContent;
{$mode delphi}
interface
uses Anims;
procedure SimBindAnimationContent;
function SimAnimationContentValid: Boolean;
function SimAnimationFrameHash(ID: Integer): QWord;
function SimAnimationFrameCount(ID: Integer): Integer;
function SimAnimationTemplateIndex(var Animation: TAnimation): Integer;
procedure SimRestoreAnimationFrames(var Animation: TAnimation; ID, Frames: Integer);
implementation
uses Game, PhysFS;
type PAnimation = ^TAnimation;
var
  Bound: Boolean;
  ContentIdentity: QWord;
  FrameHashes: array[0..43] of QWord;
  FrameCounts: array[0..43] of Integer;
function Source(ID: Integer): PAnimation;
begin
  case ID of
    0: Result := @Stand; 1: Result := @Run; 2: Result := @RunBack;
    3: Result := @Jump; 4: Result := @JumpSide; 5: Result := @Fall;
    6: Result := @Crouch; 7: Result := @CrouchRun; 8: Result := @Reload;
    9: Result := @Throw; 10: Result := @Recoil; 11: Result := @SmallRecoil;
    12: Result := @Shotgun; 13: Result := @ClipOut; 14: Result := @ClipIn;
    15: Result := @SlideBack; 16: Result := @Change; 17: Result := @ThrowWeapon;
    18: Result := @WeaponNone; 19: Result := @Punch; 20: Result := @ReloadBow;
    21: Result := @Barret; 22: Result := @Roll; 23: Result := @RollBack;
    24: Result := @CrouchRunBack; 25: Result := @Cigar; 26: Result := @Match;
    27: Result := @Smoke; 28: Result := @Wipe; 29: Result := @Groin;
    30: Result := @Piss; 31: Result := @Mercy; 32: Result := @Mercy2;
    33: Result := @TakeOff; 34: Result := @Prone; 35: Result := @Victory;
    36: Result := @Aim; 37: Result := @HandsUpAim; 38: Result := @ProneMove;
    39: Result := @GetUp; 40: Result := @AimRecoil; 41: Result := @HandsUpRecoil;
    42: Result := @Melee; 43: Result := @Own;
    else Result := nil;
  end;
end;
{$PUSH}{$Q-}{$R-}
function HashFrames(const Animation: TAnimation): QWord;
var Frame, Point, Axis, ByteIndex: Integer; Bits: LongWord;
begin
  Result := QWord($CBF29CE484222325);
  for Frame := 1 to MAX_FRAMES_INDEX do
    for Point := 1 to MAX_POS_INDEX do
      for Axis := 0 to 2 do
      begin
        case Axis of
          0: Move(Animation.Frames[Frame].Pos[Point].X, Bits, 4);
          1: Move(Animation.Frames[Frame].Pos[Point].Y, Bits, 4);
          2: Move(Animation.Frames[Frame].Pos[Point].Z, Bits, 4);
        end;
        for ByteIndex := 0 to 3 do
          Result := (Result xor Byte(Bits shr (ByteIndex * 8))) * QWord($100000001B3);
      end;
end;
{$POP}
procedure SimBindAnimationContent;
var ID: Integer; Animation: PAnimation;
begin
  for ID := 0 to 43 do
  begin
    Animation := Source(ID);
    FrameHashes[ID] := HashFrames(Animation^);
    FrameCounts[ID] := Animation^.NumFrames;
  end;
  ContentIdentity := SimVFSHash;
  Bound := True;
end;
function SimAnimationContentValid: Boolean;
var ID: Integer; Animation: PAnimation;
begin
  Result := False;
  if not Bound or (ContentIdentity <> SimVFSHash) then Exit;
  for ID := 0 to 43 do
  begin
    Animation := Source(ID);
    if (Animation^.ID <> ID) or (Animation^.NumFrames <> FrameCounts[ID]) or
       (HashFrames(Animation^) <> FrameHashes[ID]) then Exit;
  end;
  Result := True;
end;
function SimAnimationFrameHash(ID: Integer): QWord;
begin Result := FrameHashes[ID]; end;
function SimAnimationFrameCount(ID: Integer): Integer;
begin Result := FrameCounts[ID]; end;
function SimAnimationTemplateIndex(var Animation: TAnimation): Integer;
var ID: Integer;
begin
  for ID := 0 to 43 do if @Animation = Source(ID) then Exit(ID);
  Result := -1;
end;
procedure SimRestoreAnimationFrames(var Animation: TAnimation; ID, Frames: Integer);
var Template: PAnimation;
begin
  if Frames = 0 then FillChar(Animation.Frames, SizeOf(Animation.Frames), 0)
  else
  begin
    Template := Source(ID);
    if @Animation <> Template then Animation.Frames := Template^.Frames;
  end;
end;
end.
