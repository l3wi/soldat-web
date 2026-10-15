unit AI;
interface
uses Sprites;
const
  DIST_AWAY = 731;
  DIST_TOO_FAR = 730;
  DIST_VERY_FAR = 500;
  DIST_FAR = 350;
  DIST_ROCK_THROW = 180;
  DIST_CLOSE = 95;
  DIST_VERY_CLOSE = 55;
  DIST_TOO_CLOSE = 35;
  DIST_COLLIDE = 20;
  DIST_STOP_PRONE = 25;
function CheckDistance(PosA, PosB: Single): Integer;
procedure SimpleDecision(SpriteNum: Byte);
procedure GoToThing(SpriteNum, ThingNum: Byte);
procedure ControlBot(var SpriteC: TSprite);
implementation
uses SysUtils, Net;
function CheckDistance(PosA, PosB: Single): Integer;
begin
  raise ENotSupportedException.Create('AI is disabled in this simulation');
end;
procedure SimpleDecision(SpriteNum: Byte);
begin
  raise ENotSupportedException.Create('AI is disabled in this simulation');
end;
procedure GoToThing(SpriteNum, ThingNum: Byte);
begin
  raise ENotSupportedException.Create('AI is disabled in this simulation');
end;
procedure ControlBot(var SpriteC: TSprite);
begin
  if (SpriteC.Player.ControlMethod <> BOT) or SpriteC.DeadMeat or SpriteC.Dummy then
    Exit;
  raise ENotSupportedException.Create('AI is disabled in this simulation');
end;
end.
