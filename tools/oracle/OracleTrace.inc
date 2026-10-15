function F32(Value: Single): TJSONObject;
var
  Bits: LongWord;
begin
  Move(Value, Bits, SizeOf(Bits));
  Result := TJSONObject.Create;
  Result.Add('bits', LowerCase(IntToHex(Bits, 8)));
  if IsNan(Value) then Result.Add('decimal', 'NaN')
  else if IsInfinite(Value) then
  begin
    if Value < 0 then Result.Add('decimal', '-Infinity')
    else Result.Add('decimal', 'Infinity');
  end
  else Result.Add('decimal', Double(Value));
end;

function V(const Value: TVector2): TJSONArray;
begin
  Result := TJSONArray.Create;
  Result.Add(F32(Value.X));
  Result.Add(F32(Value.Y));
end;

function Particle(const P: ParticleSystem; Index: Integer): TJSONObject;
begin
  Result := TJSONObject.Create;
  Result.Add('pos', V(P.Pos[Index]));
  Result.Add('oldpos', V(P.OldPos[Index]));
  Result.Add('velocity', V(P.Velocity[Index]));
  Result.Add('forces', V(P.Forces[Index]));
end;

function Animation(const A: TAnimation): TJSONObject;
begin
  Result := TJSONObject.Create;
  Result.Add('id', A.ID);
  Result.Add('frame', A.CurrFrame);
  Result.Add('count', A.Count);
end;

function Weapon(const W: TGun): TJSONObject;
begin
  Result := TJSONObject.Create;
  Result.Add('num', W.Num);
  Result.Add('ammo', W.AmmoCount);
  Result.Add('fireInterval', W.FireIntervalCount);
  Result.Add('fireIntervalPrev', W.FireIntervalPrev);
  Result.Add('fireIntervalReal', F32(W.FireIntervalReal));
  Result.Add('startup', W.StartUpTimeCount);
  Result.Add('reload', W.ReloadTimeCount);
  Result.Add('reloadPrev', W.ReloadTimePrev);
  Result.Add('reloadReal', F32(W.ReloadTimeReal));
end;

procedure Emit(Row: TJSONObject);
begin
  {$IFDEF SIM_TRACE_BUFFER}
  SimTraceRow := Row.AsJSON;
  {$ELSE}
  WriteLn(TraceFile, Row.AsJSON);
  {$ENDIF}
  Row.Free;
end;

procedure OracleDump(const Stage: string; Entity: Integer);
var
  Row, S, B, T: TJSONObject;
  Soldiers, Bullets, Things, Skeleton: TJSONArray;
  I, J: Integer;
begin
  if not TraceOpen then Exit;
  if (Fixture <> nil) then
    if (Fixture.Get('traceStages', 'all') = 'tick') and
       (Stage <> 'initial') and (Stage <> 'tick') then Exit;
  Row := TJSONObject.Create;
  Row.Add('type', 'state');
  Row.Add('tick', CurrentTick);
  Row.Add('stage', Stage);
  Row.Add('entity', Entity);
  Row.Add('randSeed', Int64(RandSeed));
  Row.Add('jetCapacity', Map.StartJet);
  if CombatDiagnostics.Enabled then
  begin
    Row.Add('teamScores', TJSONArray.Create([TeamScore[1],TeamScore[2],TeamScore[3],TeamScore[4]]));
    Row.Add('combatHits', CombatDiagnostics.HitRows(CurrentTick));
    Row.Add('combatCollisions', CombatDiagnostics.CollisionRows(CurrentTick));
  end;
  Soldiers := TJSONArray.Create;
  Row.Add('sprites', Soldiers);
  for I := 1 to MAX_SPRITES do
    if Sprite[I].Active then
    begin
      S := TJSONObject.Create;
      Soldiers.Add(S);
      S.Add('id', I);
      S.Add('dead', Sprite[I].DeadMeat);
      S.Add('particle', Particle(SpriteParts, I));
      Skeleton := TJSONArray.Create;
      S.Add('skeleton', Skeleton);
      for J := 1 to 24 do
      begin
        B := TJSONObject.Create;
        B.Add('pos', V(Sprite[I].Skeleton.Pos[J]));
        B.Add('oldpos', V(Sprite[I].Skeleton.OldPos[J]));
        Skeleton.Add(B);
      end;
      S.Add('onGround', Sprite[I].OnGround);
      S.Add('onGroundForLaw', Sprite[I].OnGroundForLaw);
      S.Add('onGroundPermanent', Sprite[I].OnGroundPermanent);
      S.Add('onGroundLastFrame', Sprite[I].OnGroundLastFrame);
      S.Add('position', Sprite[I].Position);
      S.Add('jetsCount', Sprite[I].JetsCount);
      S.Add('legs', Animation(Sprite[I].LegsAnimation));
      S.Add('body', Animation(Sprite[I].BodyAnimation));
      S.Add('direction', Sprite[I].Direction);
      S.Add('health', F32(Sprite[I].Health));
      if CombatDiagnostics.Enabled then
      begin
        S.Add('vest', F32(Sprite[I].Vest));
        S.Add('ceaseFire', Sprite[I].CeaseFireCounter);
        S.Add('bonusStyle', Sprite[I].BonusStyle);
        S.Add('bonusTime', Sprite[I].BonusTime);
      end;
      S.Add('team', Sprite[I].Player.Team);
      S.Add('standingPolyType', Sprite[I].Player.StandingPolyType);
      S.Add('heldThing', Sprite[I].HoldedThing);
      S.Add('backgroundStatus', Sprite[I].BGState.BackgroundStatus);
      S.Add('backgroundPoly', Sprite[I].BGState.BackgroundPoly);
      S.Add('backgroundTestResult', Sprite[I].BGState.BackgroundTestResult);
      S.Add('weapon', Weapon(Sprite[I].Weapon));
      S.Add('secondaryWeapon', Weapon(Sprite[I].SecondaryWeapon));
      S.Add('tertiaryWeapon', Weapon(Sprite[I].TertiaryWeapon));
    end;
  Bullets := TJSONArray.Create;
  Row.Add('bullets', Bullets);
  for I := 1 to MAX_BULLETS do
    if Game.Bullet[I].Active then
    begin
      B := Particle(BulletParts, I);
      B.Add('id', I);
      B.Add('style', Game.Bullet[I].Style);
      B.Add('timeout', Game.Bullet[I].TimeOut);
      if CombatDiagnostics.Enabled then
      begin
        B.Add('owner', Game.Bullet[I].Owner);
        B.Add('weapon', Game.Bullet[I].OwnerWeapon);
        B.Add('hitMultiply', F32(Game.Bullet[I].HitMultiply));
        B.Add('initial', V(Game.Bullet[I].Initial));
        B.Add('degradeCount', Game.Bullet[I].DegradeCount);
        B.Add('ricochetCount', Game.Bullet[I].RicochetCount);
        B.Add('hitBody', Game.Bullet[I].HitBody);
        B.Add('hitSpot', V(Game.Bullet[I].HitSpot));
        B.Add('seed', Game.Bullet[I].Seed);
      end;
      Bullets.Add(B);
    end;
  Things := TJSONArray.Create;
  Row.Add('things', Things);
  for I := 1 to MAX_THINGS do
    if Thing[I].Active then
    begin
      T := TJSONObject.Create;
      T.Add('id', I);
      T.Add('style', Thing[I].Style);
      T.Add('timeout', Thing[I].TimeOut);
      if CombatDiagnostics.Enabled then
      begin
        T.Add('owner', Thing[I].Owner);
        T.Add('holdingSprite', Thing[I].HoldingSprite);
        T.Add('inBase', Thing[I].InBase);
        T.Add('ammo', Thing[I].AmmoCount);
      end;
      Skeleton := TJSONArray.Create;
      T.Add('particles', Skeleton);
      for J := 1 to Thing[I].Skeleton.PartCount do
        Skeleton.Add(Particle(Thing[I].Skeleton, J));
      Things.Add(T);
    end;
  Emit(Row);
end;