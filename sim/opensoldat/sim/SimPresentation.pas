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
implementation
function PointVisible(X,Y:Single;Slot:Integer):Boolean;
begin Result:=(Abs(X-CameraX)<GameWidth/2+128) and (Abs(Y-CameraY)<GameHeight/2+128);end;
function PointVisible2(X,Y:Single;Slot:Integer):Boolean;
begin Result:=PointVisible(X,Y,Slot);end;
end.
