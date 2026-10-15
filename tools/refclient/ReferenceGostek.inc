{ Render-only pose composition from native POA arrays; no gameplay update. }
function ReferenceFrame(const Anim: TAnimation; Tick: Integer): Integer;
begin
  if Anim.Loop then
    Result := (Tick div Anim.Speed) mod Anim.NumFrames + 1
  else
    Result := Min(Tick div Anim.Speed + 1, Anim.NumFrames);
end;

procedure PrepareReferenceGosteks;
var
  Slot, State, Tick, Part, Team, LegFrame, BodyFrame, BodyY, SampleTick: Integer;
  LegAnim, BodyAnim: TAnimation;
  AimAngle, ArmLength: Single;
  AimPoint, Delta, Origin: TVector2;
  Soldier: PSprite;
  PoseFile: TextFile;
begin
  LoadAnimObjects('');
  CreateWeapons(False);
  for Part := 0 to 1 do
  begin
    SetLength(MapGfx.Polys[Part], 0);
    SetLength(MapGfx.Edges[Part], 0);
  end;
  for Part := 0 to 2 do SetLength(MapGfx.Props[Part], 0);
  for Slot := 1 to 16 do
  begin
    Soldier := @Sprite[Slot];
    Soldier^.Active := True;
    Soldier^.Style := 1;
    Soldier^.Num := Slot;
    Soldier^.Visible := 255;
    Soldier^.Alpha := 255;
    Soldier^.Health := 100;
    Soldier^.Player := TPlayer.Create;
    Soldier^.Player.Name := 'Reference';
    Team := (Slot - 1) div 8 + 1;
    Soldier^.Player.Team := Team;
    Soldier^.Player.SkinColor := $EBBE8C;
    Soldier^.Player.HairColor := $5C4123;
    Soldier^.Player.HairStyle := 1;
    Soldier^.Player.Chain := 1;
    if Team = 1 then
    begin
      Soldier^.Player.ShirtColor := $D2372D;
      Soldier^.Player.PantsColor := $414637;
    end else
    begin
      Soldier^.Player.ShirtColor := $375AD2;
      Soldier^.Player.PantsColor := $323C50;
    end;
    Soldier^.HasCigar := 10;
    Soldier^.Weapon := Guns[AK74];
    Soldier^.Weapon.AmmoCount := 30;
    Soldier^.SecondaryWeapon := Guns[NOWEAPON];
    Soldier^.TertiaryWeapon := Guns[FRAGGRENADE];
    Soldier^.TertiaryWeapon.AmmoCount := 2;
    Soldier^.Skeleton := GostekSkeleton;
    State := (Slot - 1) mod 8;
    Soldier^.Direction := 1;
    if State = 1 then Soldier^.Direction := -1;
    AimAngle := 0;
    if State = 1 then AimAngle := Pi;
    if State = 2 then AimAngle := Sin(1.0) * 1.2;
    AimPoint := Vector2(Cos(AimAngle) * 1000, Sin(AimAngle) * 1000);
    LegAnim := Stand;
    BodyAnim := Stand;
    case State of
      0, 1: LegAnim := Run;
      3: begin LegAnim := Crouch; BodyAnim := Aim; end;
      4, 7: begin LegAnim := Prone; BodyAnim := Prone; end;
      5: begin
        LegAnim := Fall;
        Soldier^.Control.Jetpack := True;
        Soldier^.JetsCount := 100;
      end;
      6: BodyAnim := Reload;
    end;
    if State = 7 then
    begin
      Soldier^.DeadMeat := True;
      Soldier^.Health := 0;
    end;
    for Tick := 0 to 60 do
    begin
      SampleTick := Tick;
      if State = 7 then SampleTick := Prone.NumFrames - 1;
      LegFrame := ReferenceFrame(LegAnim, SampleTick);
      BodyFrame := ReferenceFrame(BodyAnim, SampleTick);
      BodyY := 8;
      if State = 3 then BodyY := 9;
      if BodyAnim.ID = Prone.ID then
        if BodyFrame > 9 then BodyY := -2 else BodyY := 14 - BodyFrame;
      Soldier^.Skeleton.Pos[21] := Soldier^.Skeleton.Pos[9];
      Soldier^.Skeleton.Pos[23] := Soldier^.Skeleton.Pos[12];
      for Part := 1 to 20 do
        if Part in [1, 2, 3, 4, 5, 6, 17, 18] then
          Soldier^.Skeleton.Pos[Part] := Vector2(Soldier^.Direction *
            LegAnim.Frames[LegFrame].Pos[Part].X, LegAnim.Frames[LegFrame].Pos[Part].Y);
      for Part := 1 to 20 do
        if not (Part in [1, 2, 3, 4, 5, 6, 17, 18]) then
          Soldier^.Skeleton.Pos[Part] := Vector2(Soldier^.Direction *
            BodyAnim.Frames[BodyFrame].Pos[Part].X,
            Soldier^.Skeleton.Pos[6].Y + BodyY + BodyAnim.Frames[BodyFrame].Pos[Part].Y);
      if State <> 7 then
      begin
        Delta := Vec2Subtract(Soldier^.Skeleton.Pos[12], AimPoint);
        Vec2Normalize(Delta, Delta);
        Soldier^.Skeleton.Pos[12] := Vector2(
          Soldier^.Skeleton.Pos[9].X - Soldier^.Direction * Delta.Y * 0.1,
          Soldier^.Skeleton.Pos[9].Y + Soldier^.Direction * Delta.X * 0.1);
        Soldier^.Skeleton.Pos[23] := Vector2(
          Soldier^.Skeleton.Pos[9].X - Soldier^.Direction * Delta.Y * 5,
          Soldier^.Skeleton.Pos[9].Y + Soldier^.Direction * Delta.X * 5);
        if State <> 6 then
          for Part := 15 to 19 do
            if Part in [15, 19] then
            begin
              Delta := Vec2Subtract(Soldier^.Skeleton.Pos[Part], AimPoint);
              Vec2Normalize(Delta, Delta);
              ArmLength := -7;
              if Part = 19 then ArmLength := -8;
              Vec2Scale(Delta, Delta, ArmLength);
              Soldier^.Skeleton.Pos[Part] := Vec2Add(Soldier^.Skeleton.Pos[16], Delta);
              if Part = 19 then Soldier^.Skeleton.Pos[Part].Y := Soldier^.Skeleton.Pos[Part].Y - 4;
            end;
        Soldier^.Skeleton.DoVerletTimeStepFor(22, 29);
        Soldier^.Skeleton.DoVerletTimeStepFor(24, 30);
      end else
        for Part := 29 to 30 do
          with Soldier^.Skeleton.Constraints[Part] do
            Soldier^.Skeleton.Pos[PartB] := Vec2Add(Soldier^.Skeleton.Pos[PartA],
              Vec2Subtract(GostekSkeleton.Pos[PartB], GostekSkeleton.Pos[PartA]));
    end;
    Soldier^.BodyAnimation := BodyAnim;
    Soldier^.BodyAnimation.CurrFrame := BodyFrame;
    Soldier^.LegsAnimation := LegAnim;
    Soldier^.LegsAnimation.CurrFrame := LegFrame;
    Origin := Vector2((State - 3.5) * 70, ((Slot - 1) div 8 - 0.5) * 100);
    for Part := 1 to 24 do
    begin
      Soldier^.Skeleton.Pos[Part] := Vec2Add(Soldier^.Skeleton.Pos[Part], Origin);
      Soldier^.Skeleton.OldPos[Part] := Soldier^.Skeleton.Pos[Part];
    end;
  end;
  if GetEnvironmentVariable('REFCLIENT_POSES') <> '' then
  begin
    AssignFile(PoseFile, GetEnvironmentVariable('REFCLIENT_POSES'));
    Rewrite(PoseFile);
    Write(PoseFile, '[');
    for Slot := 1 to 16 do
    begin
      if Slot > 1 then Write(PoseFile, ',');
      Write(PoseFile, '[');
      for Part := 1 to 24 do
      begin
        if Part > 1 then Write(PoseFile, ',');
        Write(PoseFile, '{"x":', FormatFloat('0.000000000', Sprite[Slot].Skeleton.Pos[Part].X),
          ',"y":', FormatFloat('0.000000000', Sprite[Slot].Skeleton.Pos[Part].Y), '}');
      end;
      Write(PoseFile, ']');
    end;
    WriteLn(PoseFile, ']');
    CloseFile(PoseFile);
  end;
end;
