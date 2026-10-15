{ Derived from OpenSoldat NetworkServerSprite.
  Copyright (c) 2020-2023 OpenSoldat contributors. MIT license. }
unit NetworkServerSprite;
interface
uses Constants, Net, Sprites;
procedure ServerSpriteSnapshot(r: Byte);
procedure ServerSpriteSnapshotMajor(r: Byte);
procedure ServerSpriteSnapshotMajorSingle(Who: Byte; r: Byte);
procedure ServerSkeletonSnapshot(r: Byte);
procedure ServerSpriteDeltas(i: Byte);
procedure ServerSpriteDeltasMouse(i: Byte);
procedure ServerSpriteDeath(Who, Killer, BulletNum, Where: Integer);
var
  OldMovementMsg: array[1..MAX_SPRITES, 1..MAX_SPRITES] of TMsg_ServerSpriteDelta_Movement;
  OldMouseAimMsg: array[1..MAX_SPRITES, 1..MAX_SPRITES] of TMsg_ServerSpriteDelta_MouseAim;
  OldWeaponsMsg: array[1..MAX_SPRITES, 1..MAX_SPRITES] of TMsg_ServerSpriteDelta_Weapons;
  OldHelmetMsg: array[1..MAX_SPRITES, 1..MAX_SPRITES] of TMsg_ServerSpriteDelta_Helmet;
  OldSpriteSnapshotMsg: array[1..MAX_SPRITES] of TMsg_ServerSpriteSnapshot;
  Time_SpriteSnapshot: array[1..MAX_SPRITES] of Integer;
  Time_SpriteSnapshot_Mov: array[1..MAX_SPRITES] of Integer;

implementation
uses Classes, SysUtils, Math, Vector, Calc, Game, Bullets, Things, Weapons, PolyMap, Util, Server, NetworkUtils, SimEvents;
procedure ServerSpriteSnapshot(r: Byte);
var
  ServerMsg: TMsg_ServerSpriteSnapshot;
  i, j: Integer;
  b: TVector2;
begin
  ServerMsg := Default(TMsg_ServerSpriteSnapshot);
  // SERVER SPRITES SNAPSHOT
  for i := 1 to MAX_SPRITES do
    if Sprite[i].Active and not Sprite[i].DeadMeat and Sprite[i].IsNotSpectator() then
    begin  // active player/sprite
      ServerMsg.Header.ID := MsgID_ServerSpriteSnapshot;
      // assign sprite values to ServerMsg
      ServerMsg.Pos := SpriteParts.Pos[i];
      ServerMsg.Velocity := SpriteParts.Velocity[i];
      ServerMsg.Num := Sprite[i].Num;
      ServerMsg.Health := Sprite[i].Health;
      ServerMsg.Position := Sprite[i].Position;
      ServerMsg.ServerTicks := ServerTickCounter;

      EncodeKeys(Sprite[i], ServerMsg.Keys16);

      ServerMsg.MouseAimY := Sprite[i].Control.MouseAimY;
      ServerMsg.MouseAimX := Sprite[i].Control.MouseAimX;

      ServerMsg.Look := 0;
      if Sprite[i].WearHelmet = 0 then
        ServerMsg.Look := ServerMsg.Look or B1;
      if Sprite[i].HasCigar = 5 then
        ServerMsg.Look := ServerMsg.Look or B2;
      if Sprite[i].HasCigar = 10 then
        ServerMsg.Look := ServerMsg.Look or B3;
      if Sprite[i].WearHelmet = 2 then
        ServerMsg.Look := ServerMsg.Look or B4;

      ServerMsg.WeaponNum := Sprite[i].Weapon.Num;
      ServerMsg.SecondaryWeaponNum := Sprite[i].SecondaryWeapon.Num;
      ServerMsg.AmmoCount := Sprite[i].Weapon.AmmoCount;
      ServerMsg.GrenadeCount := Sprite[i].TertiaryWeapon.AmmoCount;
      if Sprite[i].Vest < 0 then
        Sprite[i].Vest := 0;
      if Sprite[i].Vest > DEFAULTVEST then
        Sprite[i].Vest := DEFAULTVEST;
      ServerMsg.Vest := Sprite[i].Vest;

      b := Vec2Subtract(ServerMsg.Velocity, OldSpriteSnapshotMsg[i].Velocity);

      if ((Vec2Length(b) > VELDELTA)) or
         (MainTickCounter - Time_SpriteSnapshot_Mov[i] > 30) or
         (MainTickCounter - Time_SpriteSnapshot[i] > 30) or
         (ServerMsg.Health <> OldSpriteSnapshotMsg[i].Health) or
         (ServerMsg.Position <> OldSpriteSnapshotMsg[i].Position) or
         (ServerMsg.Keys16 <> OldSpriteSnapshotMsg[i].Keys16) or
         (ServerMsg.WeaponNum <> OldSpriteSnapshotMsg[i].WeaponNum) or
         (ServerMsg.SecondaryWeaponNum <> OldSpriteSnapshotMsg[i].SecondaryWeaponNum) or
         (ServerMsg.AmmoCount <> OldSpriteSnapshotMsg[i].AmmoCount) or
         (ServerMsg.GrenadeCount <> OldSpriteSnapshotMsg[i].GrenadeCount) or
         (ServerMsg.Vest <> OldSpriteSnapshotMsg[i].Vest) then
      begin
        // send to all
        if r = NETW then
          for j := 1 to MAX_PLAYERS do
            if (Sprite[j].Active) and (Sprite[j].Player.ControlMethod = HUMAN) then
              UDP.SendData(ServerMsg, sizeof(ServerMsg), Sprite[j].Player.peer, k_nSteamNetworkingSend_Unreliable);

      end;
      if r = NETW then
        OldSpriteSnapshotMsg[i] := ServerMsg;
    end;  // sprite[i]
end;

// SERVER SNAPSHOT MAJOR
procedure ServerSpriteSnapshotMajor(r: Byte);
var
  ServerMsg: TMsg_ServerSpriteSnapshot_Major;
  i, j: Integer;
  b: TVector2;
begin
  ServerMsg := Default(TMsg_ServerSpriteSnapshot_Major);
  // SERVER SPRITES SNAPSHOT
  for i := 1 to MAX_SPRITES do
    if Sprite[i].Active and not Sprite[i].DeadMeat and Sprite[i].IsNotSpectator() then
    begin  // active player/sprite
      ServerMsg.Header.ID := MsgID_ServerSpriteSnapshot_Major;
      // assign sprite values to ServerMsg
      ServerMsg.Pos := SpriteParts.Pos[i];
      ServerMsg.Velocity := SpriteParts.Velocity[i];
      ServerMsg.Num := Sprite[i].Num;
      ServerMsg.Health := Sprite[i].Health;
      ServerMsg.Position := Sprite[i].Position;
      ServerMsg.ServerTicks := ServerTickCounter;

      EncodeKeys(Sprite[i], ServerMsg.Keys16);

      ServerMsg.MouseAimY := Sprite[i].Control.MouseAimY;
      ServerMsg.MouseAimX := Sprite[i].Control.MouseAimX;

      b := Vec2Subtract(ServerMsg.Velocity, OldSpriteSnapshotMsg[i].Velocity);

      if ((Vec2Length(b) > VELDELTA)) or
        ((MainTickCounter - Time_SpriteSnapshot_Mov[i]) > 30) or
        (ServerMsg.Position <> OldSpriteSnapshotMsg[i].Position) or
        (ServerMsg.Health <> OldSpriteSnapshotMsg[i].Health) or
        (ServerMsg.Keys16 <> OldSpriteSnapshotMsg[i].Keys16) then
      begin
        // send to all
        if r = NETW then
          for j := 1 to MAX_PLAYERS do
            if (Sprite[j].Active) and (Sprite[j].Player.ControlMethod = HUMAN) then
              UDP.SendData(ServerMsg, sizeof(ServerMsg), Sprite[j].Player.peer, k_nSteamNetworkingSend_Unreliable);
      end;

      if r = NETW then
      begin
        OldSpriteSnapshotMsg[i].Keys16 := ServerMsg.Keys16;
        OldSpriteSnapshotMsg[i].Position := ServerMsg.Position;
        OldSpriteSnapshotMsg[i].Pos := ServerMsg.Pos;
        OldSpriteSnapshotMsg[i].Velocity := ServerMsg.Velocity;
      end;
    end;  // sprite[i]
end;

procedure ServerSpriteSnapshotMajorSingle(Who: Byte; r: Byte);
var
  ServerMsg: TMsg_ServerSpriteSnapshot_Major;
  i: Integer;
begin
  ServerMsg := Default(TMsg_ServerSpriteSnapshot_Major);
  ServerMsg.Header.ID := MsgID_ServerSpriteSnapshot_Major;
  // assign sprite values to ServerMsg
  ServerMsg.Pos := SpriteParts.Pos[who];
  ServerMsg.Velocity := SpriteParts.Velocity[who];
  ServerMsg.Num := Sprite[who].Num;
  ServerMsg.Health := Sprite[who].Health;
  ServerMsg.Position := Sprite[who].Position;
  ServerMsg.ServerTicks := ServerTickCounter;

  EncodeKeys(Sprite[who], ServerMsg.Keys16);

  ServerMsg.MouseAimY := Sprite[who].Control.MouseAimY;
  ServerMsg.MouseAimX := Sprite[who].Control.MouseAimX;
  { Original TSprite.Update respawn notification; not a periodic snapshot. }
  if r = NETW then
    SimEventInts(SIM_EVENT_RESPAWN, Who, Who,
      [Sprite[Who].Player.Team,Sprite[Who].Weapon.Num,Sprite[Who].SecondaryWeapon.Num]);

  // send to all
  if r = NETW then
    for i := 1 to MAX_PLAYERS do
      if (Sprite[i].Active) and (Sprite[i].Player.ControlMethod = HUMAN) then
      begin
        UDP.SendData(ServerMsg, sizeof(ServerMsg), Sprite[i].Player.peer, k_nSteamNetworkingSend_Unreliable);
      end;

  if r = NETW then
  begin
    OldSpriteSnapshotMsg[who].Keys16 := ServerMsg.Keys16;
    OldSpriteSnapshotMsg[who].Position := ServerMsg.Position;
    OldSpriteSnapshotMsg[who].Pos := ServerMsg.Pos;
    OldSpriteSnapshotMsg[who].Velocity := ServerMsg.Velocity;
  end;
end;

// SERVER SKELETON SNAPSHOT
procedure ServerSkeletonSnapshot(r: Byte);
var
  SkeletonMsg: TMsg_ServerSkeletonSnapshot;
  i, j: Integer;
begin
  SkeletonMsg := Default(TMsg_ServerSkeletonSnapshot);
  for i := 1 to MAX_SPRITES do
    if Sprite[i].Active and Sprite[i].DeadMeat and Sprite[i].IsNotSpectator() then
    begin  // active player/sprite
      SkeletonMsg.Header.ID := MsgID_ServerSkeletonSnapshot;
      // assign sprite values to SkeletonMsg
      SkeletonMsg.Num := Sprite[i].Num;
      if Sprite[i].RespawnCounter > 0 then
        SkeletonMsg.RespawnCounter := Sprite[i].RespawnCounter
      else
        SkeletonMsg.RespawnCounter := 0;

      // send to all
      if r = NETW then
        for j := 1 to MAX_PLAYERS do
          if (Sprite[j].Active) and (Sprite[j].Player.ControlMethod = HUMAN) then
            UDP.SendData(SkeletonMsg, sizeof(SkeletonMsg), Sprite[j].Player.peer, k_nSteamNetworkingSend_Unreliable);
    end;

end;

procedure ServerSpriteDeath(Who, Killer, BulletNum, Where: Integer);
var
  SpriteDeathMsg: TMsg_SpriteDeath;
  j: Integer;
  Weapon, BulletStyle, KillerKills, KillerTeam: Integer;
begin
  SpriteDeathMsg := Default(TMsg_SpriteDeath);
  SpriteDeathMsg.Header.ID := MsgID_SpriteDeath;
  // assign sprite values to SpriteDeathMsg
  SpriteDeathMsg.Num := Who;
  SpriteDeathMsg.Killer := Killer;
  SpriteDeathMsg.Where := Where;
  SpriteDeathMsg.RespawnCounter := Sprite[Who].RespawnCounter;
  SpriteDeathMsg.Health := Sprite[Who].Health;
  SpriteDeathMsg.OnFire := Sprite[Who].OnFire;
  SpriteDeathMsg.ShotDistance := ShotDistance;
  SpriteDeathMsg.ShotLife := ShotLife;
  SpriteDeathMsg.ShotRicochet := ShotRicochet;

  if (BulletNum = -1) then
    SpriteDeathMsg.KillBullet := 250
  else
  begin
    // if Bullet[BulletNum].OwnerWeapon = 0 then
      // SpriteDeathMsg.KillBullet := 250;
    SpriteDeathMsg.KillBullet := Bullet[BulletNum].OwnerWeapon;
    if Bullet[BulletNum].Style = 2 then
      SpriteDeathMsg.KillBullet := 222;
    if Bullet[BulletNum].Style = 10 then
      SpriteDeathMsg.KillBullet := 210;
    if Bullet[BulletNum].Style = 5 then
      SpriteDeathMsg.KillBullet := 205;
    if Bullet[BulletNum].Style = 7 then
      SpriteDeathMsg.KillBullet := 207;
    if Bullet[BulletNum].Style = 8 then
      SpriteDeathMsg.KillBullet := 208;
    if Bullet[BulletNum].Style = 6 then
      SpriteDeathMsg.KillBullet := 206;
    if Bullet[BulletNum].OwnerWeapon = Guns[KNIFE].Num then
      SpriteDeathMsg.KillBullet := 211;
    if Bullet[BulletNum].OwnerWeapon = Guns[CHAINSAW].Num then
      SpriteDeathMsg.KillBullet := 212;
    if Bullet[BulletNum].Style = 12 then
      SpriteDeathMsg.KillBullet := 224;
    if Bullet[BulletNum].Style = 13 then
      SpriteDeathMsg.KillBullet := 211;
    if Bullet[BulletNum].Style = 14 then
      SpriteDeathMsg.KillBullet := 225;
  end;
  { Original TSprite.Die -> ServerSpriteDeath carries the actual attribution.
    Gameplay kinds are intentionally retained during REPLAY. }
  Weapon:=250; BulletStyle:=0; KillerKills:=0; KillerTeam:=0;
  if BulletNum<>-1 then begin Weapon:=Bullet[BulletNum].OwnerWeapon; BulletStyle:=Bullet[BulletNum].Style; end;
  if (Killer>=1) and (Killer<=MAX_PLAYERS) then
  begin KillerKills:=Sprite[Killer].Player.Kills; KillerTeam:=Sprite[Killer].Player.Team; end;
  SimEventInts(SIM_EVENT_DEATH,Killer,Who,
    [Weapon,SpriteDeathMsg.KillBullet,BulletStyle,Where,KillerKills,KillerTeam,Sprite[Who].Player.Team]);
  SimEventInts(SIM_EVENT_TEAM_SCORES,0,0,
    [TeamScore[0],TeamScore[1],TeamScore[2],TeamScore[3],TeamScore[4],TeamScore[5]]);

  for j := 1 to 16 do
  begin
    SpriteDeathMsg.Pos[j].X := Sprite[Who].Skeleton.Pos[j].X;
    SpriteDeathMsg.Pos[j].Y := Sprite[Who].Skeleton.Pos[j].Y;
    SpriteDeathMsg.OldPos[j].X := Sprite[Who].Skeleton.OldPos[j].X;
    SpriteDeathMsg.OldPos[j].Y := Sprite[Who].Skeleton.OldPos[j].Y;
  end;

  SpriteDeathMsg.Constraints := 0;
  if not Sprite[Who].Skeleton.Constraints[2].Active then
    SpriteDeathMsg.Constraints := SpriteDeathMsg.Constraints or B1;
  if not Sprite[Who].Skeleton.Constraints[4].Active then
    SpriteDeathMsg.Constraints := SpriteDeathMsg.Constraints or B2;
  if not Sprite[Who].Skeleton.Constraints[20].Active then
    SpriteDeathMsg.Constraints := SpriteDeathMsg.Constraints or B3;
  if not Sprite[Who].Skeleton.Constraints[21].Active then
    SpriteDeathMsg.Constraints := SpriteDeathMsg.Constraints or B4;
  if not Sprite[Who].Skeleton.Constraints[23].Active then
    SpriteDeathMsg.Constraints := SpriteDeathMsg.Constraints or B5;

  for j := 1 to MAX_PLAYERS do
    if (Sprite[j].Active) and (Sprite[j].Player.ControlMethod = HUMAN) then
      UDP.SendData(SpriteDeathMsg, sizeof(SpriteDeathMsg), Sprite[j].Player.peer, k_nSteamNetworkingSend_Unreliable);
end;

// SEND DELTAS OF SPRITE
procedure ServerSpriteDeltas(i: Byte);
var
  MovementMsg: TMsg_ServerSpriteDelta_Movement;
  WeaponsMsg: TMsg_ServerSpriteDelta_Weapons;
  HelmetMsg: TMsg_ServerSpriteDelta_Helmet;
  j: Integer;
  a, b: TVector2;
begin
  MovementMsg := Default(TMsg_ServerSpriteDelta_Movement);
  WeaponsMsg := Default(TMsg_ServerSpriteDelta_Weapons);
  HelmetMsg := Default(TMsg_ServerSpriteDelta_Helmet);
  HelmetMsg.Header.ID := MsgID_Delta_Helmet;
  HelmetMsg.Num := i;
  HelmetMsg.WearHelmet := Sprite[i].WearHelmet;

  MovementMsg.Header.ID := MsgID_Delta_Movement;
  MovementMsg.Num := i;

  MovementMsg.Velocity := SpriteParts.Velocity[i];
  MovementMsg.Pos := SpriteParts.Pos[i];
  MovementMsg.ServerTick := ServerTickCounter;

  EncodeKeys(Sprite[i], MovementMsg.Keys16);

  MovementMsg.MouseAimY := Sprite[i].Control.MouseAimY;
  MovementMsg.MouseAimX := Sprite[i].Control.MouseAimX;

  WeaponsMsg.Header.ID := MsgID_Delta_Weapons;
  WeaponsMsg.Num := i;
  WeaponsMsg.WeaponNum := Sprite[i].Weapon.Num;
  WeaponsMsg.SecondaryWeaponNum := Sprite[i].SecondaryWeapon.Num;
  WeaponsMsg.AmmoCount := Sprite[i].Weapon.AmmoCount;

  for j := 1 to MAX_SPRITES do
    if Sprite[j].Active and (Sprite[j].Player.ControlMethod = HUMAN) and (j <> i) then
      if PointVisible(SpriteParts.Pos[i].X, SpriteParts.Pos[i].Y, Sprite[j].Player.Camera) or
         (Sprite[j].IsSpectator() and (Sprite[j].Player.Port = 0)) then  // visible to sprite
      begin
        a := Vec2Subtract(MovementMsg.Pos, OldMovementMsg[j, i].Pos);
        b := Vec2Subtract(MovementMsg.Velocity, OldMovementMsg[j, i].Velocity);
        if (Sprite[i].Player.ControlMethod = HUMAN) or
           (((Vec2Length(a) > POSDELTA) or (Vec2Length(b) > VELDELTA)) and
             (MovementMsg.Keys16 <> OldMovementMsg[j, i].Keys16)) then
        begin
          UDP.SendData(MovementMsg, sizeof(MovementMsg), Sprite[j].Player.peer, k_nSteamNetworkingSend_Unreliable);
          OldMovementMsg[j, i] := MovementMsg;
        end;
      end;

  for j := 1 to MAX_SPRITES do
    if Sprite[j].Active and (Sprite[j].Player.ControlMethod = HUMAN) and (j <> i) then
      if (WeaponsMsg.WeaponNum <> OldWeaponsMsg[j, i].WeaponNum) or
         (WeaponsMsg.SecondaryWeaponNum <> OldWeaponsMsg[j, i].SecondaryWeaponNum) then
        if PointVisible(SpriteParts.Pos[i].X, SpriteParts.Pos[i].Y, Sprite[j].Player.Camera) or
           (Sprite[j].IsSpectator() and (Sprite[j].Player.Port = 0)) then  // visible to sprite
        begin
          UDP.SendData(WeaponsMsg, sizeof(WeaponsMsg), Sprite[j].Player.peer, k_nSteamNetworkingSend_Unreliable);
          OldWeaponsMsg[j, i] := WeaponsMsg;
        end;

  for j := 1 to MAX_SPRITES do
    if (Sprite[j].Active) and (Sprite[j].Player.ControlMethod = HUMAN) and (j <> i) then
      if HelmetMsg.WearHelmet <> OldHelmetMsg[j, i].WearHelmet then
      begin
        UDP.SendData(HelmetMsg, sizeof(HelmetMsg), Sprite[j].Player.peer, k_nSteamNetworkingSend_Unreliable);
        OldHelmetMsg[j, i] := HelmetMsg;
      end;
end;

procedure ServerSpriteDeltasMouse(i: Byte);
var
  MouseAimMsg: TMsg_ServerSpriteDelta_MouseAim;
  j: Integer;
begin
  MouseAimMsg := Default(TMsg_ServerSpriteDelta_MouseAim);
  MouseAimMsg.Header.ID := MsgID_Delta_MouseAim;
  MouseAimMsg.Num := i;
  MouseAimMsg.MouseAimY := Sprite[i].Control.MouseAimY;
  MouseAimMsg.MouseAimX := Sprite[i].Control.MouseAimX;

  for j := 1 to MAX_SPRITES do
    if (Sprite[j].Active) and (Sprite[j].Player.ControlMethod = HUMAN) and (j <> i) then
    begin
      UDP.SendData(MouseAimMsg, sizeof(MouseAimMsg), Sprite[j].Player.peer, k_nSteamNetworkingSend_Unreliable);
      OldMouseAimMsg[j, i] := MouseAimMsg;
    end;
end;

end.
