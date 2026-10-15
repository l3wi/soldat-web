unit CombatDiagnostics;
{$mode delphi}
interface
uses fpjson, SysUtils;
const COLLISION_MAP = 1; COLLISION_COLLIDER = 2;
  COLLISION_SPRITE = 3; COLLISION_THING = 4;
var Enabled: Boolean = False;
procedure Reset;
procedure RecordHit(Tick, Bullet, Owner, Target, Where: Integer);
function HitRows(Tick: Integer): TJSONArray;
procedure RecordCollision(Tick, Bullet, Kind, Entity, Where: Integer;
  Accepted: Boolean; X,Y,Distance,Limit: Single);
function CollisionRows(Tick: Integer): TJSONArray;
implementation
type THit = record Bullet, Owner, Target, Where: Integer; end;
  TCollision = record
    Bullet, Kind, Entity, Where: Integer;
    Accepted: Boolean;
    X,Y,Distance,Limit: Single;
  end;
var Hits: array[0..4095] of THit;
  HitTick: Integer = -1;
  HitCount, Overflow: Integer;
  Collisions: array[0..4095] of TCollision;
  CollisionTick: Integer = -1;
  CollisionCount, CollisionOverflow: Integer;
  LastAccepted: array[0..255] of Integer; // Original bullet slots are 1..254.
procedure Reset;
begin
  HitTick := -1; HitCount := 0; Overflow := 0;
  CollisionTick := -1; CollisionCount := 0; CollisionOverflow := 0;
end;
procedure RecordHit(Tick, Bullet, Owner, Target, Where: Integer);
begin
  if not Enabled then Exit;
  if Tick <> HitTick then begin HitTick := Tick; HitCount := 0; Overflow := 0; end;
  if HitCount = Length(Hits) then begin Inc(Overflow); Exit; end;
  Hits[HitCount].Bullet := Bullet; Hits[HitCount].Owner := Owner;
  Hits[HitCount].Target := Target; Hits[HitCount].Where := Where;
  Inc(HitCount);
end;
function HitRows(Tick: Integer): TJSONArray;
var I: Integer; Row: TJSONObject;
begin
  Result := TJSONArray.Create;
  if HitTick <> Tick then Exit;
  for I := 0 to HitCount-1 do
  begin
    Row := TJSONObject.Create;
    Row.Add('bullet',Hits[I].Bullet); Row.Add('owner',Hits[I].Owner);
    Row.Add('target',Hits[I].Target); Row.Add('where',Hits[I].Where);
    Result.Add(Row);
  end;
  if Overflow <> 0 then
  begin
    Row := TJSONObject.Create; Row.Add('overflow',Overflow); Result.Add(Row);
  end;
end;
procedure RecordCollision(Tick, Bullet, Kind, Entity, Where: Integer;
  Accepted: Boolean; X,Y,Distance,Limit: Single);
var I: Integer;
begin
  if not Enabled then Exit;
  if Tick <> CollisionTick then
  begin
    CollisionTick := Tick; CollisionCount := 0; CollisionOverflow := 0;
    for I := Low(LastAccepted) to High(LastAccepted) do LastAccepted[I] := -1;
  end;
  if CollisionCount = Length(Collisions) then begin Inc(CollisionOverflow); Exit; end;
  Collisions[CollisionCount].Bullet := Bullet;
  Collisions[CollisionCount].Kind := Kind;
  Collisions[CollisionCount].Entity := Entity;
  Collisions[CollisionCount].Where := Where;
  Collisions[CollisionCount].Accepted := Accepted;
  Collisions[CollisionCount].X := X; Collisions[CollisionCount].Y := Y;
  Collisions[CollisionCount].Distance := Distance; Collisions[CollisionCount].Limit := Limit;
  if Accepted then LastAccepted[Bullet] := CollisionCount;
  Inc(CollisionCount);
end;
function CollisionFloat(Value: Single): TJSONObject;
var Bits: LongWord;
begin
  Move(Value,Bits,SizeOf(Bits)); Result := TJSONObject.Create;
  Result.Add('bits',LowerCase(IntToHex(Bits,8))); Result.Add('decimal',Double(Value));
end;
function CollisionRows(Tick: Integer): TJSONArray;
const Kinds: array[1..4] of string = ('map','collider','sprite','thing');
var I: Integer; Row: TJSONObject;
begin
  Result := TJSONArray.Create;
  if Tick <> CollisionTick then Exit;
  for I := 0 to CollisionCount-1 do
  begin
    Row := TJSONObject.Create;
    Row.Add('sequence',I); Row.Add('bullet',Collisions[I].Bullet);
    Row.Add('kind',Kinds[Collisions[I].Kind]); Row.Add('entity',Collisions[I].Entity);
    Row.Add('where',Collisions[I].Where); Row.Add('accepted',Collisions[I].Accepted);
    Row.Add('winner',Collisions[I].Accepted and (LastAccepted[Collisions[I].Bullet] = I));
    Row.Add('x',CollisionFloat(Collisions[I].X)); Row.Add('y',CollisionFloat(Collisions[I].Y));
    Row.Add('distance',CollisionFloat(Collisions[I].Distance));
    Row.Add('priorLimit',CollisionFloat(Collisions[I].Limit)); Result.Add(Row);
  end;
  if CollisionOverflow <> 0 then
  begin
    Row := TJSONObject.Create; Row.Add('overflow',CollisionOverflow); Result.Add(Row);
  end;
end;
end.
