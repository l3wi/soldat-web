{ Derived from OpenSoldat NetworkUtils.
  Copyright (c) 2020-2023 OpenSoldat contributors. MIT license. }
unit NetworkUtils;
interface
uses Sprites;
function IsRemoteAdminIP(IP: string): Boolean;
function IsAdminIP(IP: string): Boolean;
function CheckWeaponNotAllowed(I: Byte): Boolean;
procedure EncodeKeys(var SpriteC: TSprite; out Keys16: Word);
procedure DecodeKeys(var SpriteC: TSprite; var Keys16: Word);
procedure StringToArray(var C: array of Char; S: string);
implementation
uses SysUtils, Constants, Net, Game, Server, Weapons, TraceLog;
procedure EncodeKeys(var SpriteC: TSprite; out Keys16: Word);
var
  Controls: ^TControl;
begin
  Controls := @SpriteC.Control;

  Keys16 := 0;
  if Controls.Left         then Keys16 := Keys16 or B1;
  if Controls.Right        then Keys16 := Keys16 or B2;
  if Controls.Up           then Keys16 := Keys16 or B3;
  if Controls.Down         then Keys16 := Keys16 or B4;
  if Controls.Fire         then Keys16 := Keys16 or B5;
  if Controls.Jetpack      then Keys16 := Keys16 or B6;
  if Controls.ThrowNade    then Keys16 := Keys16 or B7;
  if Controls.ChangeWeapon then Keys16 := Keys16 or B8;
  if Controls.ThrowWeapon  then Keys16 := Keys16 or B9;
  if Controls.Reload       then Keys16 := Keys16 or B10;
  if Controls.FlagThrow    then Keys16 := Keys16 or B11;

  if SpriteC.BodyAnimation.ID = Change.ID then
    Keys16 := Keys16 or B8;
  if SpriteC.BodyAnimation.ID = ThrowWeapon.ID then
    Keys16 := Keys16 or B9;
end;

procedure DecodeKeys(var SpriteC: TSprite; var Keys16: Word);
var
  Controls: ^TControl;
begin
  Controls := @SpriteC.Control;

  Controls.Left         := Keys16 and B1  = B1;
  Controls.Right        := Keys16 and B2  = B2;
  Controls.Up           := Keys16 and B3  = B3;
  Controls.Down         := Keys16 and B4  = B4;
  Controls.Fire         := Keys16 and B5  = B5;
  Controls.Jetpack      := Keys16 and B6  = B6;
  Controls.ThrowNade    := Keys16 and B7  = B7;
  Controls.ChangeWeapon := Keys16 and B8  = B8;
  Controls.ThrowWeapon  := Keys16 and B9  = B9;
  Controls.Reload       := Keys16 and B10 = B10;
  Controls.FlagThrow    := Keys16 and B11 = B11;
end;
function IsRemoteAdminIP(IP: string): Boolean;
begin
  Result := RemoteIPs.IndexOf(IP) > -1;
end;

// Checks if the IP string is inside the admin IPs list
function IsAdminIP(IP: string): Boolean;
begin
  Result := AdminIPs.IndexOf(IP) > -1;
end;
function CheckWeaponNotAllowed(i: Byte): Boolean;
var
  WeaponIndex: Integer;
begin
  Trace('CheckWeaponNotAllowed');

  Result := True;

  WeaponIndex := WeaponNumToIndex(Sprite[i].Weapon.Num);
  if IsMainWeaponIndex(WeaponIndex) and (WeaponActive[WeaponIndex] = 0) then
    Exit;

  if ((Sprite[i].Weapon.Num = Guns[BOW].Num)    and (sv_gamemode.Value <> GAMESTYLE_RAMBO)) or
     ((Sprite[i].Weapon.Num = Guns[BOW2].Num)   and (sv_gamemode.Value <> GAMESTYLE_RAMBO)) or
     ((Sprite[i].Weapon.Num = Guns[FLAMER].Num) and (sv_bonus_flamer.Value)) then
    Exit;

  Result := False;
end;
procedure StringToArray(var c: array of Char; s: string);
var
  i: Integer;
begin
  FillChar(c, sizeOf(c), 0);

  if Length(s) < 1 then
    Exit;
  if Length(c) < 1 then
    Exit;
  if Length(s) > Length(c) then
    Exit;

  for i := 0 to Length(s) - 1 do
  begin
    c[i] := s[i + 1];
  end;
  if Length(s) < Length(c) then
    c[Length(s)] := #0;
end;
end.
