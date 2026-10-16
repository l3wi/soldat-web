unit SimPresentation;
{$mode delphi}{$H+}
interface
uses Vector;
type TFXIntegerSetting=record Value:Integer; end;
  TFXBooleanSetting=record Value:Boolean; end;
var
  MySprite,CameraFollowSprite: Integer;
  CameraX,CameraY: Single;
  GameWidth:Single=854; GameHeight:Single=480;
  GrenadeEffectTimer:Integer;
  FXWhizzed:array[1..254] of Boolean;
  r_maxsparks:TFXIntegerSetting=(Value:557);
  snd_effects_explosions:TFXBooleanSetting=(Value:False);
function PointVisible(X,Y:Single; Slot:Integer):Boolean;
function PointVisible2(X,Y:Single; Slot:Integer):Boolean;
procedure EmitBink(Slot,Amount:Integer);
procedure EmitHitBink(Victim,Attacker:Integer);
implementation
uses SimEvents, Game, Sprites, Server;
procedure EmitBink(Slot,Amount:Integer);
begin SimEventInts($80001001,Slot,0,[Amount]);end;
procedure EmitHitBink(Victim,Attacker:Integer);
begin
  if (Sprite[Victim].Weapon.Bink>0) and
    ((Victim=Attacker) or sv_friendlyfire.Value or Sprite[Victim].IsSolo or
      Sprite[Victim].IsNotInSameTeam(Sprite[Attacker])) then
    EmitBink(Victim,Sprite[Victim].Weapon.Bink);
end;
function PointVisible(X,Y:Single;Slot:Integer):Boolean;
begin Result:=(Abs(X-CameraX)<GameWidth/2+128) and (Abs(Y-CameraY)<GameHeight/2+128);end;
function PointVisible2(X,Y:Single;Slot:Integer):Boolean;
begin Result:=PointVisible(X,Y,Slot);end;
end.
