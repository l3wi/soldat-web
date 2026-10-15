{ Derived from OpenSoldat NetworkServerBullet.
  Copyright (c) 2020-2023 OpenSoldat contributors. MIT license. }
unit NetworkServerBullet;
interface
uses Constants, Net;
procedure ServerBulletSnapshot(i: Byte; {$IFDEF SERVER}ToNum: Byte;{$ENDIF} Forced: Boolean);

implementation
uses Classes, SysUtils, Math, Vector, Calc, Game, Sprites, Bullets, Things, Weapons, PolyMap, Util, Server, NetworkUtils;
procedure ServerBulletSnapshot(i: Byte; {$IFDEF SERVER}ToNum: Byte;{$ENDIF} Forced: Boolean);
var
  BulletMsg: TMsg_BulletSnapshot;
  {$IFDEF SERVER}
  j: Integer;
  {$ENDIF}
begin
  BulletMsg := Default(TMsg_BulletSnapshot);
  // SERVER BULLETS SNAPSHOT
  BulletMsg.Header.ID := MsgID_BulletSnapshot;
  BulletMsg.Owner := Bullet[i].Owner;
  BulletMsg.WeaponNum := Bullet[i].OwnerWeapon;
  BulletMsg.Pos := BulletParts.Pos[i];
  BulletMsg.Velocity := BulletParts.Velocity[i];
  BulletMsg.Seed := Bullet[i].Seed;
  BulletMsg.Forced := Forced;

  {$IFDEF SERVER}
  if not Forced then
    if (Sprite[BulletMsg.owner].Weapon.AmmoCount > 0) and
      (Bullet[i].Style <> BULLET_STYLE_FRAGNADE) and
      (Bullet[i].Style <> BULLET_STYLE_CLUSTERNADE) and
      (Bullet[i].Style <> BULLET_STYLE_CLUSTER) then
        Dec(Sprite[BulletMsg.owner].Weapon.AmmoCount);

  for j := 1 to MAX_SPRITES do
    if Sprite[j].Active and
       (Sprite[j].Player.ControlMethod = HUMAN) and ((j <> Bullet[i].Owner) or Forced) then
       if (ToNum = 0) or (j = ToNum) then
        if BulletCanSend(Bulletparts.Pos[i].X, Bulletparts.Pos[i].Y,
         Sprite[j].Player.Camera, Bulletparts.Velocity[i].X) or Forced then
      begin
        UDP.SendData(BulletMsg, sizeof(BulletMsg), Sprite[j].Player.peer, k_nSteamNetworkingSend_Unreliable);
      end;
  {$ELSE}
  DemoRecorder.SaveRecord(BulletMsg, sizeof(BulletMsg));
  {$ENDIF}
end;

end.
