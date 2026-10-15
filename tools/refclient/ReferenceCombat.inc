{ Rendering-only gallery. Original TBullet/TThing/RenderInterface draw routines
  consume explicit native state; this does not demonstrate gameplay behavior. }
function ReferenceNumber(Value: Single): string;
var
  Settings: TFormatSettings;
begin
  Settings := DefaultFormatSettings;
  Settings.DecimalSeparator := '.';
  Result := FloatToStr(Value, Settings);
end;

procedure PrepareReferenceCombat;
const
  WeaponIndices: array[1..14] of Integer =
    (AK74, FRAGGRENADE, SPAS12, M79, FLAMER, NOWEAPON, BOW,
     BOW2, CLUSTERGRENADE, CLUSTER, KNIFE, LAW, THROWNKNIFE, M2);
  ThingStyles: array[1..5] of Byte =
    (OBJECT_AK74, OBJECT_MEDICAL_KIT, OBJECT_GRENADE_KIT,
     OBJECT_ALPHA_FLAG, OBJECT_BRAVO_FLAG);
var
  Slot, Part, Layer, WeaponIndex, ThingIndex: Integer;
  Mode: string;
  Position: TVector2;
begin
  Mode := GetEnvironmentVariable('REFCLIENT_COMBAT');
  if not ((Mode = 'objects') or (Mode = 'hud') or (Mode = 'hud-reload') or (Mode = 'hud-full')) then
    raise Exception.Create('REFCLIENT_COMBAT must be objects, hud, hud-reload, or hud-full');
  LoadAnimObjects('');
  CreateWeapons(False);
  for Layer := 0 to 1 do
  begin
    SetLength(MapGfx.Polys[Layer], 0);
    SetLength(MapGfx.Edges[Layer], 0);
  end;
  for Layer := 0 to 2 do SetLength(MapGfx.Props[Layer], 0);
  for Slot := 1 to MAX_SPRITES do Sprite[Slot].Active := False;
  for Slot := 1 to MAX_BULLETS do Bullet[Slot].Active := False;
  for Slot := 1 to MAX_THINGS do Thing[Slot].Active := False;
  Trails := 1;
  GameThingTarget := 0;
  sv_gamemode.SetValue(GAMESTYLE_CTF);
  sv_realisticmode.SetValue(False);
  MySprite := 0;

  { Allocate every native style, including 6 and 11 which intentionally have no
    TBullet.Render branch. Flame and M2 use their own visible timeout ranges. }
  for Slot := 1 to 14 do
  begin
    WeaponIndex := WeaponIndices[Slot];
    Bullet[Slot].Active := Mode = 'objects';
    Bullet[Slot].Num := Slot;
    Bullet[Slot].Style := Slot;
    Bullet[Slot].Owner := 0;
    Bullet[Slot].OwnerWeapon := Guns[WeaponIndex].Num;
    Bullet[Slot].ImageStyle := Guns[WeaponIndex].BulletImageStyle;
    Bullet[Slot].TimeOut := 180;
    if Slot = BULLET_STYLE_FLAME then Bullet[Slot].TimeOut := 20;
    if Slot = BULLET_STYLE_M2 then Bullet[Slot].TimeOut := 40;
    Bullet[Slot].TimeOutPrev := Bullet[Slot].TimeOut;
    Bullet[Slot].TimeOutReal := Bullet[Slot].TimeOut;
    Bullet[Slot].HitMultiply := Guns[WeaponIndex].HitMultiply;
    Bullet[Slot].HitMultiplyPrev := Bullet[Slot].HitMultiply;
    Position := Vector2(-300 + ((Slot - 1) mod 7) * 100,
      -150 + ((Slot - 1) div 7) * 70);
    BulletParts.Pos[Slot] := Position;
    BulletParts.OldPos[Slot] := Vec2Subtract(Position, Vector2(12, 0));
    BulletParts.Velocity[Slot] := Vector2(12, 0);
    Bullet[Slot].VelocityPrev := BulletParts.Velocity[Slot];
    Bullet[Slot].Initial := Vec2Subtract(Position, Vector2(120, 0));
  end;

  for Slot := 1 to 5 do
  begin
    ThingIndex := CreateThing(Vector2(-240 + (Slot - 1) * 120, 100),
      255, ThingStyles[Slot], Slot);
    if ThingIndex <> Slot then raise Exception.Create('Native gallery thing allocation failed');
    Thing[Slot].AmmoCount := 20;
    Thing[Slot].TimeOut := 600;
    for Part := 1 to Thing[Slot].Skeleton.PartCount do
      Thing[Slot].Skeleton.OldPos[Part] := Thing[Slot].Skeleton.Pos[Part];
    Thing[Slot].Active := Mode = 'objects';
  end;

  { Raster isolation keeps the slot inactive. Full HUD activates a non-gostek
    style below so original sorting/interpolation run without soldier art. }
  Sprite[1].Player := TPlayer.Create;
  Sprite[1].Player.Name := 'Reference';
  Sprite[1].Player.Team := TEAM_ALPHA;
  Sprite[1].Player.ControlMethod := HUMAN;
  Sprite[1].Style := 1;
  Sprite[1].Direction := 1;
  Sprite[1].Visible := 255;
  Sprite[1].Alpha := 255;
  Sprite[1].Skeleton := GostekSkeleton;
  Sprite[1].Num := 1;
  Sprite[1].Health := 75;
  Sprite[1].Weapon := Guns[AK74];
  Sprite[1].Weapon.AmmoCount := 20;
  Sprite[1].Weapon.ReloadTime := 150;
  Sprite[1].Weapon.ReloadTimeCount := 0;
  Sprite[1].Weapon.ReloadTimeReal := 0;
  if Mode = 'hud-reload' then
  begin
    Sprite[1].Weapon.AmmoCount := 0;
    Sprite[1].Weapon.ReloadTimeCount := 75;
    Sprite[1].Weapon.ReloadTimeReal := 75;
  end;
  Sprite[1].TertiaryWeapon := Guns[FRAGGRENADE];
  Sprite[1].TertiaryWeapon.AmmoCount := 3;
  Map.StartJet := 100;
  Sprite[1].JetsCount := 50;
  Sprite[1].JetsCountReal := 50;
  if Mode <> 'objects' then MySprite := 1;
  r_renderui.SetValue(Mode <> 'objects');
  NoTexts := 0;
  if Mode = 'hud-full' then
  begin
    { The ordinary bootstrap creates menus/names after the map-view early exit.
      Complete those original UI prerequisites, without entering game/network. }
    InitGameMenus;
    LoadWeaponNames;
    MapChangeCounter := -1;
    mx := GameWidthHalf;
    my := GameHeightHalf;
    MousePrev := Vector2(mx, my);
    CameraFollowSprite := MySprite;
    Sprite[1].Active := True;
    Sprite[1].Style := 0;
    SortPlayers;
    while MainConsole.Count > 0 do MainConsole.ScrollConsole;
  end;

end;

procedure WriteReferenceCombat;
var
  Slot, Part: Integer;
  Mode: string;
  Gallery: TextFile;
begin
  { RenderFrame has now run the original interpolation, so Real counters
    describe the actual native HUD frame, not uninitialized bootstrap values. }
  Mode := GetEnvironmentVariable('REFCLIENT_COMBAT');
  if GetEnvironmentVariable('REFCLIENT_COMBAT_JSON') = '' then Exit;
  AssignFile(Gallery, GetEnvironmentVariable('REFCLIENT_COMBAT_JSON'));
  Rewrite(Gallery);
  Write(Gallery, '{"kind":"native-render-gallery","mode":"', Mode,
    '","map":"Airpirates","width":1280,"height":720,"gameWidth":853,"gameHeight":480,',
    '"camera":{"x":0,"y":0,"z":0},"filter":"linear","mipmaps":false,',
    '"timeElapsed":0,"gameMode":3,"trails":1,"targetThing":0,"paused":true,"bullets":[');
  for Slot := 1 to 14 do
  begin
    if Slot > 1 then Write(Gallery, ',');
    Write(Gallery, '{"slot":', Slot, ',"style":', Bullet[Slot].Style,
      ',"owner":', Bullet[Slot].Owner, ',"ownerWeapon":', Bullet[Slot].OwnerWeapon,
      ',"imageStyle":', Bullet[Slot].ImageStyle,
      ',"posX":', ReferenceNumber(BulletParts.Pos[Slot].X),
      ',"posY":', ReferenceNumber(BulletParts.Pos[Slot].Y),
      ',"oldPosX":', ReferenceNumber(BulletParts.OldPos[Slot].X),
      ',"oldPosY":', ReferenceNumber(BulletParts.OldPos[Slot].Y),
      ',"velocityX":12,"velocityY":0,"velocityPrevX":12,"velocityPrevY":0',
      ',"timeout":', Bullet[Slot].TimeOut, ',"timeoutPrev":', Bullet[Slot].TimeOutPrev,
      ',"timeoutReal":', ReferenceNumber(Bullet[Slot].TimeOutReal),
      ',"hitMultiply":', ReferenceNumber(Bullet[Slot].HitMultiply),
      ',"hitMultiplyPrev":', ReferenceNumber(Bullet[Slot].HitMultiplyPrev),
      ',"initialX":', ReferenceNumber(Bullet[Slot].Initial.X),
      ',"initialY":', ReferenceNumber(Bullet[Slot].Initial.Y),
      ',"pingAdd":', Bullet[Slot].PingAdd, ',"pingAddStart":', Bullet[Slot].PingAddStart,
      ',"hitBody":', Bullet[Slot].HitBody, ',"active":',
      LowerCase(BoolToStr(Bullet[Slot].Active, True)), ',"presentationFlags":0}');
  end;
  Write(Gallery, '],"things":[');
  for Slot := 1 to 5 do
  begin
    if Slot > 1 then Write(Gallery, ',');
    Write(Gallery, '{"slot":', Slot, ',"style":', Thing[Slot].Style,
      ',"owner":', Thing[Slot].Owner, ',"ammo":', Thing[Slot].AmmoCount,
      ',"holdingSprite":', Thing[Slot].HoldingSprite,
      ',"flags":', Ord(Thing[Slot].StaticType) + 2 * Ord(Thing[Slot].InBase),
      ',"timeout":', Thing[Slot].TimeOut, ',"tex1":', Thing[Slot].Tex1,
      ',"tex2":', Thing[Slot].Tex2, ',"texture":', Thing[Slot].Texture,
      ',"color":', Thing[Slot].Color, ',"interest":', Thing[Slot].Interest,
      ',"presentationFlags":1,"creationFacing":0',
      ',"posX":', ReferenceNumber(Thing[Slot].Skeleton.Pos[1].X),
      ',"posY":', ReferenceNumber(Thing[Slot].Skeleton.Pos[1].Y),
      ',"oldPosX":', ReferenceNumber(Thing[Slot].Skeleton.OldPos[1].X),
      ',"oldPosY":', ReferenceNumber(Thing[Slot].Skeleton.OldPos[1].Y),
      ',"pointCount":', Thing[Slot].Skeleton.PartCount, ',"skeleton":[');
    for Part := 1 to Thing[Slot].Skeleton.PartCount do
    begin
      if Part > 1 then Write(Gallery, ',');
      Write(Gallery, '{"x":', ReferenceNumber(Thing[Slot].Skeleton.Pos[Part].X),
        ',"y":', ReferenceNumber(Thing[Slot].Skeleton.Pos[Part].Y),
        ',"oldX":', ReferenceNumber(Thing[Slot].Skeleton.OldPos[Part].X),
        ',"oldY":', ReferenceNumber(Thing[Slot].Skeleton.OldPos[Part].Y), '}');
    end;
    Write(Gallery, ']}');
  end;
  Write(Gallery, '],"globals":{"teamScores":[');
  for Slot := 0 to 5 do
  begin
    if Slot > 0 then Write(Gallery, ',');
    Write(Gallery, TeamScore[Slot]);
  end;
  Write(Gallery, '],"startHealth":', StartHealth, ',"mapStartJet":', Map.StartJet,
    ',"gameMode":', sv_gamemode.Value, ',"killLimit":', sv_killlimit.Value,
    ',"ceaseFireTime":', CeaseFireTime, '}');
  WriteLn(Gallery, ',"hud":{"rasterOnly":', LowerCase(BoolToStr(Mode <> 'hud-full', True)),
    ',"health":', ReferenceNumber(Sprite[1].Health), ',"startHealth":', StartHealth,
    ',"weapon":', Sprite[1].Weapon.Num, ',"ammo":', Sprite[1].Weapon.AmmoCount,
    ',"ammoCapacity":', Sprite[1].Weapon.Ammo, ',"grenades":', Sprite[1].TertiaryWeapon.AmmoCount,
    ',"fuel":', Sprite[1].JetsCount, ',"vest":', ReferenceNumber(Sprite[1].Vest),
    ',"tertiaryWeapon":', Sprite[1].TertiaryWeapon.Num,
    ',"jetCapacity":', Map.StartJet, ',"reload":', Sprite[1].Weapon.ReloadTimeCount,
    ',"reloadReal":', ReferenceNumber(Sprite[1].Weapon.ReloadTimeReal),
    ',"reloadTime":', Sprite[1].Weapon.ReloadTime,
    ',"fireInterval":', Sprite[1].Weapon.FireInterval,
    ',"fireIntervalCount":', Sprite[1].Weapon.FireIntervalCount,
    ',"fireIntervalReal":', ReferenceNumber(Sprite[1].Weapon.FireIntervalReal),
    ',"kills":', Sprite[1].Player.Kills, ',"deaths":', Sprite[1].Player.Deaths,
    ',"ping":', Sprite[1].Player.RealPing, ',"team":', Sprite[1].Player.Team,
    ',"playerName":"Reference","controlMethod":', Sprite[1].Player.ControlMethod,
    ',"gameMode":', sv_gamemode.Value, ',"killLimit":', sv_killlimit.Value,
    ',"timeLeftSeconds":', TimeLimitCounter div 60, ',"playersNum":', PlayersNum,
    ',"spectatorsNum":', SpectatorsNum, ',"cameraFollowSprite":', CameraFollowSprite,
    ',"consoleMessages":', MainConsole.Count, ',"cursorX":', ReferenceNumber(mx),
    ',"cursorY":', ReferenceNumber(my),
    ',"indicatorWorldX":', ReferenceNumber(Sprite[1].Skeleton.Pos[12].X),
    ',"indicatorWorldY":', ReferenceNumber(Sprite[1].Skeleton.Pos[12].Y),
    ',"active":', LowerCase(BoolToStr(Sprite[1].Active, True)),
    ',"flags":', Ord(Sprite[1].Active) + 2 * Ord(Sprite[1].DeadMeat),
    ',"style":', Sprite[1].Style, ',"playerFlags":', Sprite[1].Player.Flags,
    ',"sortedFirstPlayer":', SortedPlayers[1].PlayerNum, ',"sortedTeamScores":[');
  for Slot := 1 to 4 do
  begin
    if Slot > 1 then Write(Gallery, ',');
    Write(Gallery, '{"team":', SortedTeamScore[Slot].PlayerNum,
      ',"kills":', SortedTeamScore[Slot].Kills,
      ',"color":', SortedTeamScore[Slot].Color, '}');
  end;
  WriteLn(Gallery, ']}}');
  CloseFile(Gallery);
end;
