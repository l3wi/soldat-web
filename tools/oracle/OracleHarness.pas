unit OracleHarness;

interface

procedure RunOracle;
procedure OracleDump(const Stage: string; Entity: Integer);

implementation

uses
  Classes, SysUtils, Math, fpjson, jsonparser, PhysFS,
  Anims, Constants, Cvar, Demo, Game, LogFile, Net, Parts, PolyMap, Server,
  ServerLoop, SharedConfig, Sprites, Things, Bullets, Util, Vector, Weapons, CombatDiagnostics;

var
  Fixture: TJSONObject;
  TraceFile: Text;
  TraceOpen: Boolean = False;
  CurrentTick: Integer = 0;
  WasRunningLeft, WasJumping: array[1..MAX_PLAYERS] of Boolean;
  Authoritative: array[1..MAX_PLAYERS] of Boolean;
  BotPlayer: array[1..MAX_PLAYERS] of Boolean;
  ChosenPrimary, ChosenSecondary: array[1..MAX_PLAYERS] of Byte;
  WasDead: array[1..MAX_PLAYERS] of Boolean;
  LimboAvailable: array[1..MAX_PLAYERS] of Boolean;


{$I OracleTrace.inc}

function ReadControl(Data: TJSONObject): TControl;
begin
  Result := Default(TControl);
  Result.Left := Data.Get('Left', False);
  Result.Right := Data.Get('Right', False);
  Result.Up := Data.Get('Up', False);
  Result.Down := Data.Get('Down', False);
  Result.Fire := Data.Get('Fire', False);
  Result.Jetpack := Data.Get('Jetpack', False);
  Result.ThrowNade := Data.Get('ThrowNade', False);
  Result.ChangeWeapon := Data.Get('ChangeWeapon', False);
  Result.ThrowWeapon := Data.Get('ThrowWeapon', False);
  Result.Reload := Data.Get('Reload', False);
  Result.Prone := Data.Get('Prone', False);
  Result.FlagThrow := Data.Get('FlagThrow', False);
  Result.MouseAimX := Data.Get('MouseAimX', 0);
  Result.MouseAimY := Data.Get('MouseAimY', 0);
  Result.MouseDist := Data.Get('MouseDist', 0);
end;

procedure InjectInputs;
var
  Inputs: TJSONArray;
  Input: TJSONObject;
  Selected: array[1..MAX_PLAYERS] of TJSONObject;
  I, Slot, Order: Integer;
begin
  for I := 1 to MAX_SPRITES do
    if Sprite[I].Active then
    begin
      if (I > MAX_PLAYERS) or not BotPlayer[I] then
        Sprite[I].Control := Default(TControl);
      NoClientUpdateTime[I] := 0;
    end;
  for I := 1 to MAX_PLAYERS do Selected[I] := nil;
  Inputs := Fixture.Arrays['inputs'];
  for I := 0 to Inputs.Count - 1 do
  begin
    Input := TJSONObject(Inputs[I]);
    if (CurrentTick >= Input.Integers['start']) and
       (CurrentTick < Input.Integers['start'] + Input.Integers['ticks']) then
    begin
      Slot := Input.Integers['player'];
      if (Slot < 1) or (Slot > MAX_PLAYERS) or not Sprite[Slot].Active then
        raise Exception.Create('Input references inactive player');
      if BotPlayer[Slot] then raise Exception.Create('Cannot inject bot controls');
      Selected[Slot] := Input;
    end;
  end;
  // Resolve exactly once per player, including neutral ticks. Later segments win.
  for Slot := 1 to MAX_PLAYERS do
    if Sprite[Slot].Active and not BotPlayer[Slot] then
    begin
      Input := Selected[Slot];
      Order := 0;
      if Input <> nil then
      begin
        Sprite[Slot].Control := ReadControl(Input.Objects['control']);
        Order := Input.Get('pressOrder', 0);
      end;
      if Sprite[Slot].Control.Left and Sprite[Slot].Control.Right and (Order <> 0) then
      begin
        if (Order and 3) = 3 then raise Exception.Create('Conflicting pressOrder bits');
        if (Order and 3) <> 0 then WasRunningLeft[Slot] := (Order and 1) <> 0;
        // The client resolves first/new direction before serializing server TControl.
        if WasJumping[Slot] then
        begin
          Sprite[Slot].Control.Left := WasRunningLeft[Slot];
          Sprite[Slot].Control.Right := not WasRunningLeft[Slot];
        end
        else
        begin
          Sprite[Slot].Control.Left := not WasRunningLeft[Slot];
          Sprite[Slot].Control.Right := WasRunningLeft[Slot];
        end;
      end
      else if not (Sprite[Slot].Control.Left and Sprite[Slot].Control.Right) then
      begin
        WasRunningLeft[Slot] := Sprite[Slot].Control.Left;
        WasJumping[Slot] := Sprite[Slot].Control.Up;
      end;
      if Authoritative[Slot] then
      begin
        // Original HUMAN guards run in ControlSprite after firing. The server
        // adapter applies their held-trigger state before the BOT authority path
        // decrements cooldowns; Dummy keeps the original AI disabled.
        if not Sprite[Slot].Control.Fire then Sprite[Slot].BurstCount := 0;
        if (Sprite[Slot].Weapon.FireMode = 2) and Sprite[Slot].Control.Fire and
           ((Sprite[Slot].BurstCount > 0) or Sprite[Slot].Control.Reload) and
           (Sprite[Slot].Weapon.FireIntervalCount < 2) then
          Inc(Sprite[Slot].Weapon.FireIntervalCount);
      end;
    end;
end;
// Injection only: all subsequent updates remain pinned upstream mechanics.
procedure InjectCommands(Tick: Integer);
var Commands: TJSONArray; Cmd: TJSONObject; I, Slot, Target, Circle, Index: Integer;
  Pos, Velocity: TVector2; Kind: string; HitM: Single;
begin
  if Fixture.Find('commands') = nil then Exit;
  Commands := Fixture.Arrays['commands'];
  for I := 0 to Commands.Count-1 do
  begin
    Cmd := TJSONObject(Commands[I]);
    if Cmd.Integers['tick'] <> Tick then Continue;
    Kind := Cmd.Strings['kind'];
    if Kind = 'weapon-choice' then
    begin
      Slot := Cmd.Integers['slot'];
      if (Slot < 1) or (Slot > MAX_PLAYERS) or not Sprite[Slot].Active then
        raise Exception.Create('Invalid weapon-choice sprite');
      Index := WeaponNumToIndex(Cmd.Integers['weapon']);
      if Index < 1 then raise Exception.Create('Invalid chosen primary');
      ChosenPrimary[Slot] := Cmd.Integers['weapon'];
      if Cmd.Find('secondaryWeapon') <> nil then
      begin
        Index := WeaponNumToIndex(Cmd.Integers['secondaryWeapon']);
        if Index < 1 then raise Exception.Create('Invalid chosen secondary');
        ChosenSecondary[Slot] := Cmd.Integers['secondaryWeapon'];
      end;
    end
    else if Kind = 'weapon-apply' then
    begin
      Slot := Cmd.Integers['slot'];
      if (Slot < 1) or (Slot > MAX_PLAYERS) or not Sprite[Slot].Active then
        raise Exception.Create('Invalid weapon-apply sprite');
      if not Authoritative[Slot] or not LimboAvailable[Slot] or Sprite[Slot].DeadMeat then
        raise Exception.Create('Weapon menu unavailable');
      if (Cmd.Get('selection','primary') <> 'primary') and
         (Cmd.Get('selection','primary') <> 'secondary') then
        raise Exception.Create('Invalid weapon menu selection');
      if Cmd.Get('selection','primary') = 'primary' then
      begin
        if Sprite[Slot].Weapon.Num in [Guns[BOW].Num, Guns[BOW2].Num] then
          raise Exception.Create('Weapon menu unavailable with bow');
        Index := WeaponNumToIndex(Cmd.Integers['weapon']);
        if (Index < 1) or (Index > PRIMARY_WEAPONS) then
          raise Exception.Create('Invalid menu primary');
        if (WeaponActive[Index] <> 1) or (WeaponSel[Slot][Index] <> 1) then
          raise Exception.Create('Disabled menu primary');
      end
      else if Cmd.Find('secondaryWeapon') = nil then
        raise Exception.Create('Secondary selection requires secondaryWeapon');
      if Cmd.Find('secondaryWeapon') <> nil then
      begin
        Index := WeaponNumToIndex(Cmd.Integers['secondaryWeapon']);
        if (Index < COLT) or (Index > LAW) then
          raise Exception.Create('Invalid menu secondary');
        if (WeaponActive[Index] <> 1) or (WeaponSel[Slot][Index] <> 1) then
          raise Exception.Create('Disabled menu secondary');
        ChosenSecondary[Slot] := Cmd.Integers['secondaryWeapon'];
        Sprite[Slot].Player.SecWep := Index - COLT;
        Sprite[Slot].ApplyWeaponByNum(ChosenSecondary[Slot],2);
      end;
      if Cmd.Get('selection','primary') = 'primary' then
      begin
        LimboAvailable[Slot] := False;
        ChosenPrimary[Slot] := Cmd.Integers['weapon'];
        Sprite[Slot].SelWeapon := ChosenPrimary[Slot];
        Sprite[Slot].ApplyWeaponByNum(ChosenPrimary[Slot],1);
      end;
    end
    else if Kind = 'fixture-sprite' then
    begin
      Slot := Cmd.Integers['slot'];
      if (Slot < 1) or (Slot > MAX_PLAYERS) or not Sprite[Slot].Active then
        raise Exception.Create('Invalid fixture sprite');
      if Cmd.Strings['bodyAnimation'] <> 'Throw' then raise Exception.Create('Unsupported animation');
      Sprite[Slot].BodyApplyAnimation(Throw,Cmd.Integers['bodyFrame']);
      Sprite[Slot].GrenadeCanThrow := False;
      Sprite[Slot].CeaseFireCounter := -1;
      if Cmd.Find('grenadeWeapon') <> nil then
      begin
        if Cmd.Integers['grenadeWeapon'] = FRAGGRENADE_NUM then
          Sprite[Slot].TertiaryWeapon := Guns[FRAGGRENADE]
        else if Cmd.Integers['grenadeWeapon'] = CLUSTERGRENADE_NUM then
          Sprite[Slot].TertiaryWeapon := Guns[CLUSTERGRENADE]
        else raise Exception.Create('Invalid grenade weapon');
        Sprite[Slot].TertiaryWeapon.AmmoCount := 3;
      end;
    end
    else if (Kind = 'thing') or (Kind = 'bullet') then
    begin
      Pos.X := Cmd.Floats['x']; Pos.Y := Cmd.Floats['y'];
      if Kind = 'thing' then
      begin
        if CreateThing(Pos,Cmd.Get('owner',0),Cmd.Integers['style'],Cmd.Get('ammo',255)) < 1 then
          raise Exception.Create('Thing injection failed');
      end
      else
      begin
        Target := Cmd.Get('target',0); Circle := Cmd.Get('hitCircle',0);
        if Target <> 0 then
        begin
          if (Target < 1) or (Target > MAX_PLAYERS) or not Sprite[Target].Active then
            raise Exception.Create('Invalid bullet target');
          if not (Circle in [3,4,5,6,10,11,12]) then raise Exception.Create('Invalid hit circle');
          Pos.X := Pos.X + Sprite[Target].Skeleton.Pos[Circle].X - 2;
          Pos.Y := Pos.Y + Sprite[Target].Skeleton.Pos[Circle].Y;
        end;
        Velocity.X := Cmd.Floats['vx']; Velocity.Y := Cmd.Floats['vy'];
        Index := WeaponNumToIndex(Cmd.Integers['weapon']);
        if Index < 1 then raise Exception.Create('Invalid injected weapon');
        HitM := Guns[Index].HitMultiply;
        if Cmd.Find('hitMultiply') <> nil then HitM := Cmd.Floats['hitMultiply'];
        Index := CreateBullet(Pos,Velocity,Cmd.Integers['weapon'],Cmd.Integers['owner'],255,HitM,False,True);
        if Index < 1 then raise Exception.Create('Bullet injection failed');
        if Cmd.Find('timeout') <> nil then Game.Bullet[Index].TimeOut := Cmd.Integers['timeout'];
      end;
    end
    else raise Exception.Create('Unsupported oracle fixture command: '+Kind);
  end;
end;

procedure RunOracle;
var
  Source: TFileStream;
  Info: TMapInfo;
  Players: TJSONArray;
  PlayerSpec, Header: TJSONObject;
  P: TPlayer;
  Pos, Velocity: TVector2;
  I, Spawn, Slot, FlagSlot, FlagStyle, TickCount, Tick, Difficulty: Integer;
  Profile, BotDirectory: string;
begin
  if ParamCount <> 4 then
    raise Exception.Create('Usage: opensoldatserver FIXTURE TRACE BASE-SMOD USER-DIR');
  Source := TFileStream.Create(ParamStr(1), fmOpenRead or fmShareDenyWrite);
  try Fixture := TJSONObject(GetJSON(Source)); finally Source.Free; end;
  if Fixture.Integers['version'] <> 1 then raise Exception.Create('Unsupported fixture version');
  TickCount := Fixture.Integers['ticks'];
  if TickCount < 1 then raise Exception.Create('Fixture ticks must be positive');
  DefaultFormatSettings.DecimalSeparator := '.';
  SetExceptionMask([exInvalidOp, exDenormalized, exZeroDivide, exOverflow,
    exUnderflow, exPrecision]);
  RandSeed := Fixture.Int64s['seed'];
  CombatDiagnostics.Reset;
  CvarInit;
  sv_gamemode.SetValue(GAMESTYLE_DEATHMATCH);
  bots_chat.SetValue(False);
  bots_difficulty.SetValue(100);
  if Fixture.Find('rules') <> nil then
  begin
    CombatDiagnostics.Enabled := Fixture.Objects['rules'].Get('traceCombat',False);
    if Fixture.Objects['rules'].Get('mode','dm') = 'ctf' then sv_gamemode.SetValue(GAMESTYLE_CTF);
    if Fixture.Objects['rules'].Get('rng','original') <> 'original' then
      raise Exception.Create('Oracle supports original RNG only');
    if Fixture.Objects['rules'].Find('botDifficulty') <> nil then
      if Fixture.Objects['rules'].Find('botDifficulty').JSONType <> jtNumber then
        raise Exception.Create('botDifficulty must be an integer');
    if Frac(Fixture.Objects['rules'].Get('botDifficulty',100.0)) <> 0 then
      raise Exception.Create('botDifficulty must be an integer');
    Difficulty := Fixture.Objects['rules'].Get('botDifficulty',100);
    if (Difficulty < 0) or (Difficulty > 300) then
      raise Exception.Create('botDifficulty must be in 0..300');
    bots_difficulty.SetValue(Difficulty);
  end;
  sv_bonus_frequency.SetValue(0);
  sv_survivalmode.SetValue(False);
  sv_realisticmode.SetValue(False);
  sv_lobby.SetValue(False);
  sc_enable.SetValue(False);
  log_enable.SetValue(False);
  demo_autorecord.SetValue(False);
  sv_timelimit.SetValue(360000);
  UserDirectory := IncludeTrailingPathDelimiter(ParamStr(4));
  BaseDirectory := ExtractFilePath(ParamStr(3));
  MainConsole.CountMax := 7;
  if not PhysFS_Init(PChar(ParamStr(0))) then raise Exception.Create('PhysFS init failed');
  if not PhysFS_mount(PChar(ParamStr(3)), '/', False) then raise Exception.Create('PhysFS mount failed');
  // A test-only raw PMS mount may shadow a stock basename without editing base.
  if Fixture.Get('mapDirectory', '') <> '' then
    if not PhysFS_mount(PChar(Fixture.Strings['mapDirectory']), '/', False) then
      raise Exception.Create('Fixture map mount failed');
  DummyPlayer := TPlayer.Create;
  for I := 1 to MAX_SPRITES do Sprite[I].Player := DummyPlayer;
  for I := 1 to MAIN_WEAPONS do WeaponActive[I] := 1;
  LoadAnimObjects('');
  if not GetMapInfo(Fixture.Strings['map'], UserDirectory, Info) then
    raise Exception.Create('Map not found');
  if not Map.LoadMap(Info) then raise Exception.Create('Map load failed');
  StartHealth := DEFAULT_HEALTH;
  LoadWeapons('weapons');
  MapChangeCounter := -60;
  BulletTimeTimer := -1;
  TimeLimitCounter := 360000;
  Players := Fixture.Arrays['players'];
  if (Players.Count < 1) or (Players.Count > MAX_PLAYERS) then raise Exception.Create('Invalid player count');
  for I := 0 to Players.Count - 1 do
  begin
    PlayerSpec := TJSONObject(Players[I]);
    BotPlayer[I+1] := PlayerSpec.Get('control','human') = 'bot';
    Authoritative[I+1] := PlayerSpec.Get('control','human') = 'authoritative';
    Pos := Default(TVector2);
    Velocity := Default(TVector2);
    P := TPlayer.Create;
    P.Team := PlayerSpec.Integers['team'];
    P.ControlMethod := HUMAN;
    if BotPlayer[I+1] then
    begin
      if Fixture.Find('rules') = nil then raise Exception.Create('Bots require ai:true');
      if not Fixture.Objects['rules'].Get('ai',False) then raise Exception.Create('Bots require ai:true');
      P.ApplyShirtColorFromTeam;
      RandomizeStart(Pos,P.Team);
    end
    else
    begin
      Spawn := PlayerSpec.Integers['spawnpoint'];
      if (Spawn < 1) or (Spawn > MAX_SPAWNPOINTS) then raise Exception.Create('Invalid spawnpoint');
      if not Map.Spawnpoints[Spawn].Active then raise Exception.Create('Inactive spawnpoint');
      Pos.X := Map.Spawnpoints[Spawn].X;
      Pos.Y := Map.Spawnpoints[Spawn].Y;
      if PlayerSpec.Find('x') <> nil then Pos.X := PlayerSpec.Floats['x'];
      if PlayerSpec.Find('y') <> nil then Pos.Y := PlayerSpec.Floats['y'];
      if Authoritative[I+1] then P.ControlMethod := BOT;
    end;
    P.Name := 'oracle-' + IntToStr(I + 1);
    Slot := CreateSprite(Pos, Velocity, 1, I + 1, P, True);
    if Slot <> I + 1 then raise Exception.Create('Unexpected sprite slot');
    LimboAvailable[Slot] := True;
    if BotPlayer[Slot] then
    begin
      Profile := LowerCase(PlayerSpec.Strings['bot']);
      if (Profile = '') or (ExtractFileName(Profile) <> Profile) or
         (System.Pos('..',Profile) <> 0) or (System.Pos('\',Profile) <> 0) then
        raise Exception.Create('Invalid bot profile');
      BotDirectory := IncludeTrailingPathDelimiter(Fixture.Get('botDirectory','/sim-content/bots'));
      if not LoadBotConfig(BotDirectory + Profile + '.bot',Sprite[Slot]) then
        raise Exception.Create('Bot profile load failed: ' + Profile);
      Sprite[Slot].Respawn;
      Sprite[Slot].Player.ControlMethod := BOT;
      Sprite[Slot].Player.ChatWarnings := 0;
      Sprite[Slot].Player.GrabsPerSecond := 0;
      SortPlayers;
      Continue;
    end;
    if Authoritative[Slot] then Sprite[Slot].Dummy := True;
    if PlayerSpec.Find('health') <> nil then Sprite[Slot].Health := PlayerSpec.Floats['health'];
    if PlayerSpec.Find('weapon') <> nil then Sprite[Slot].ApplyWeaponByNum(PlayerSpec.Integers['weapon'],1,PlayerSpec.Get('ammo',-1));
    if PlayerSpec.Find('secondaryWeapon') <> nil then Sprite[Slot].ApplyWeaponByNum(PlayerSpec.Integers['secondaryWeapon'],2);
    if PlayerSpec.Find('grenades') <> nil then Sprite[Slot].TertiaryWeapon.AmmoCount := PlayerSpec.Integers['grenades'];
    if PlayerSpec.Find('vest') <> nil then Sprite[Slot].Vest := PlayerSpec.Floats['vest'];
    if Authoritative[Slot] then Sprite[Slot].Brain.FavWeapon := Sprite[Slot].Weapon.Num;
    ChosenPrimary[Slot] := Sprite[Slot].Weapon.Num;
    ChosenSecondary[Slot] := Sprite[Slot].SecondaryWeapon.Num;
    FlagStyle := PlayerSpec.Get('heldFlag', 0);
    if FlagStyle <> 0 then
    begin
      if (FlagStyle < 1) or (FlagStyle > 3) then raise Exception.Create('Invalid heldFlag style');
      FlagSlot := CreateThing(Pos, Slot, FlagStyle, 255);
      if FlagSlot < 1 then raise Exception.Create('Flag creation failed');
      Thing[FlagSlot].HoldingSprite := Slot;
      Sprite[Slot].HoldedThing := FlagSlot;
    end;
  end;
  InjectCommands(0);
  AssignFile(TraceFile, ParamStr(2));
  Rewrite(TraceFile);
  TraceOpen := True;
  Header := TJSONObject.Create;
  Header.Add('type', 'header');
  Header.Add('version', 1);
  Header.Add('upstream', 'bf43a43bdd7a069e02c906768807f66e621b2888');
  Header.Add('compiler', {$I %FPCVERSION%});
  Header.Add('map', Fixture.Strings['map']);
  Header.Add('contentSetHash', Fixture.Strings['contentSetHash']);
  Header.Add('seed', Fixture.Int64s['seed']);
  Header.Add('ticks', TickCount);
  Header.Add('jetCapacity', Map.StartJet);
  Emit(Header);
  OracleDump('initial', 0);
  for Tick := 1 to TickCount do
  begin
    CurrentTick := Tick;
    Inc(Ticks);
    Inc(ServerTickCounter);
    Inc(MainTickCounter);
    InjectInputs;
    for Slot := 1 to MAX_PLAYERS do
      if Sprite[Slot].Active and Authoritative[Slot] then
      begin
        WasDead[Slot] := Sprite[Slot].DeadMeat;
        Sprite[Slot].Brain.FavWeapon := ChosenPrimary[Slot];
      end;
    UpdateFrame;
    for Slot := 1 to MAX_PLAYERS do
      if Sprite[Slot].Active and Authoritative[Slot] and
         WasDead[Slot] and not Sprite[Slot].DeadMeat then
      begin
        Sprite[Slot].ApplyWeaponByNum(ChosenPrimary[Slot],1);
        Sprite[Slot].ApplyWeaponByNum(ChosenSecondary[Slot],2);
        LimboAvailable[Slot] := True;
      end;
    InjectCommands(Tick);
    OracleDump('tick', 0);
  end;
  CloseFile(TraceFile);
  TraceOpen := False;
  Fixture.Free;
end;

end.
