unit SimCore;
{$mode delphi}
{$H+}
interface
const
  SIM_OK = 0;
  SIM_INVALID = -1;
  SIM_NOT_INITIALIZED = -2;
  SIM_MISSING = -3;
  SIM_UNSUPPORTED = -4;
  SIM_CAPACITY = -5;
  SIM_MALFORMED = -6;
type TSimTraceHook = procedure(const Stage: string; Entity: Integer);
var SimTraceHook: TSimTraceHook = nil;
function sim_version: LongWord;
function sim_alloc(Size: LongWord): Pointer;
procedure sim_free(Buffer: Pointer);
function sim_vfs_put(Path: Pointer; PathLength: LongWord; Data: Pointer; DataLength: LongWord): LongInt;
function sim_init(Rules: Pointer; RulesLength, SeedLo, SeedHi, Flags: LongWord): LongInt;
function sim_load_map(Name: Pointer; NameLength: LongWord): LongInt;
function sim_command(Tick: LongWord; Data: Pointer; Length: LongWord): LongInt;
function sim_set_input(Slot, Tick: LongWord; Data: Pointer): LongInt;
function sim_step(Flags: LongWord): LongInt;
function sim_events(Buffer: Pointer; Capacity: LongWord): LongInt;
function sim_render_view: Pointer;
function sim_save_state(Buffer: Pointer; Capacity: LongWord): LongInt;
function sim_load_state(Buffer: Pointer; Length: LongWord): LongInt;
function sim_hash_state: QWord;
function sim_trace_state(Buffer: Pointer; Capacity: LongWord): LongInt;
function fx_step: LongInt;
function fx_render_view: LongInt;
function fx_set_view(X,Y,Width,Height:Single; Slot:LongWord):LongInt;
implementation
uses Classes, SysUtils, Math, fpjson, jsonparser, PhysFS, Anims,
  Constants, Cvar, Demo, Game, Net, Parts, PolyMap, Server, Sprites,
  Things, Bullets, Util, Vector, Weapons, SimState, SimRender, SimEvents,
  NetworkServerSprite, NetworkServerGame, SimAnimationContent, SimRandom, Sparks, SimFXRandom,
  SimPresentation, CombatDiagnostics, SharedConfig, ServerHelper;
var
  Initialized, MapLoaded, CvarsReady: Boolean;
  Fixture: TJSONObject = nil;
  TraceOpen: Boolean;
  CurrentTick: Integer;
  SimTraceRow: AnsiString;
{$DEFINE SIM_TRACE_BUFFER}
{$I ../../../tools/oracle/OracleTrace.inc}
{$UNDEF SIM_TRACE_BUFFER}
function sim_version: LongWord;
begin Result := SIM_ABI_VERSION; end;
function sim_alloc(Size: LongWord): Pointer;
begin
  Result := nil;
  if (Size = 0) or (Size > 64*1024*1024) then Exit;
  GetMem(Result, Size);
end;
procedure sim_free(Buffer: Pointer);
begin if Buffer <> nil then FreeMem(Buffer); end;
function TextArgument(Data: Pointer; Length: LongWord; out Value: AnsiString): Boolean;
var J: LongWord;
begin
  Result := False;
  if (Data = nil) or (Length = 0) or (Length > 65535) then Exit;
  for J := 0 to Length-1 do if PByte(Data)[J] = 0 then Exit;
  SetString(Value, PAnsiChar(Data), Length); Result := True;
end;
function ReadObject(Data: Pointer; Length: LongWord; out Obj: TJSONObject): Boolean;
var S: AnsiString; Parsed: TJSONData;
begin
  Obj := nil; Result := False;
  if not TextArgument(Data, Length, S) then Exit;
  try
    Parsed := GetJSON(S);
    if Parsed.JSONType <> jtObject then begin Parsed.Free; Exit; end;
    Obj := TJSONObject(Parsed); Result := True;
  except on E: Exception do Result := False; end;
end;
function sim_vfs_put(Path: Pointer; PathLength: LongWord; Data: Pointer; DataLength: LongWord): LongInt;
var S: AnsiString;
begin
  if Initialized then Exit(SIM_INVALID);
  SimInvalidateState;
  if not TextArgument(Path,PathLength,S) or ((Data = nil) and (DataLength <> 0)) then Exit(SIM_INVALID);
  if SimVFSPut(S,Data,DataLength) then Result := SIM_OK else Result := SIM_INVALID;
end;
function RulesSupported(Obj: TJSONObject): Boolean;
var J: Integer; Name: AnsiString; Value: TJSONData;
begin
  Result := False;
  for J := 0 to Obj.Count-1 do
  begin
    Name := Obj.Names[J]; Value := Obj.Items[J];
    if Name = 'mode' then
    begin if (Value.JSONType <> jtString) or ((Value.AsString <> 'dm') and (Value.AsString <> 'ctf')) then Exit; end
    else if Name = 'rng' then
    begin if (Value.JSONType <> jtString) or ((Value.AsString <> 'original') and (Value.AsString <> 'keyed')) then Exit; end
    else if Name = 'ai' then
    begin if Value.JSONType <> jtBoolean then Exit; end
    else if Name = 'botDifficulty' then
    begin if (Value.JSONType <> jtNumber) or (Frac(Value.AsFloat)<>0) or
      (Value.AsFloat<0) or (Value.AsFloat>300) then Exit; end
    else if (Name = 'realistic') or (Name = 'survival') then
    begin if (Value.JSONType <> jtBoolean) or Value.AsBoolean then Exit; end
    else if Name = 'bonusFrequency' then
    begin if (Value.JSONType <> jtNumber) or (Value.AsFloat <> 0) then Exit; end
    else if Name = 'tickRate' then
    begin if (Value.JSONType <> jtNumber) or (Value.AsFloat <> 60) then Exit; end
    else if Name='traceCombat' then begin if Value.JSONType<>jtBoolean then Exit;end
    else Exit;
  end;
  Result := True;
end;
procedure ClearEntities;
var J: Integer;
begin
  for J := 1 to MAX_SPRITES do
  begin
    if Sprite[J].IsPlayerObjectOwner and (Sprite[J].Player <> DummyPlayer) then Sprite[J].Player.Free;
    Sprite[J] := Default(TSprite);
    Sprite[J].Player := DummyPlayer;
  end;
  for J := 1 to MAX_BULLETS do Bullet[J] := Default(TBullet);
  for J := 1 to MAX_THINGS do Thing[J] := Default(TThing);
end;
function sim_init(Rules: Pointer; RulesLength, SeedLo, SeedHi, Flags: LongWord): LongInt;
const RequiredFiles: array[0..49] of PChar = (
  'anims/stoi.poa', 'anims/biega.poa', 'anims/biegatyl.poa',
  'anims/skok.poa', 'anims/skokwbok.poa', 'anims/spada.poa',
  'anims/kuca.poa', 'anims/kucaidzie.poa', 'anims/laduje.poa',
  'anims/rzuca.poa', 'anims/odrzut.poa', 'anims/odrzut2.poa',
  'anims/shotgun.poa', 'anims/clipout.poa', 'anims/clipin.poa',
  'anims/slideback.poa', 'anims/change.poa', 'anims/wyrzuca.poa',
  'anims/bezbroni.poa', 'anims/bije.poa', 'anims/strzala.poa',
  'anims/barret.poa', 'anims/skokdolobrot.poa', 'anims/skokdolobrottyl.poa',
  'anims/kucaidzietyl.poa', 'anims/cigar.poa', 'anims/match.poa',
  'anims/smoke.poa', 'anims/wipe.poa', 'anims/krocze.poa',
  'anims/szcza.poa', 'anims/samo.poa', 'anims/samo2.poa',
  'anims/takeoff.poa', 'anims/lezy.poa', 'anims/cieszy.poa',
  'anims/celuje.poa', 'anims/gora.poa', 'anims/lezyidzie.poa',
  'anims/wstaje.poa', 'anims/celujeodrzut.poa', 'anims/goraodrzut.poa',
  'anims/kolba.poa', 'anims/rucha.poa', 'objects/gostek.po',
  'objects/kit.po', 'objects/flag.po', 'objects/para.po',
  'objects/stat.po', 'objects/karabin.po');
var Obj: TJSONObject; J,Mode,Difficulty: Integer; Keyed,TraceCombat,EnableAI:Boolean;
begin
  if Initialized then Exit(SIM_UNSUPPORTED);
  SimInvalidateState;
  if Flags and not LongWord(2) <> 0 then Exit(SIM_UNSUPPORTED);
  if not ReadObject(Rules,RulesLength,Obj) then Exit(SIM_MALFORMED);
  try
    if not RulesSupported(Obj) then Exit(SIM_UNSUPPORTED);
    Keyed := (Obj.Get('rng','original')='keyed') or (Flags and 2<>0);
    if not Keyed and (SeedHi<>0) then Exit(SIM_UNSUPPORTED);
    Mode:=GAMESTYLE_DEATHMATCH;
    if Obj.Get('mode','dm')='ctf' then Mode:=GAMESTYLE_CTF;
    TraceCombat:=Obj.Get('traceCombat',False);
    EnableAI:=Obj.Get('ai',False);Difficulty:=Obj.Get('botDifficulty',100);
  finally Obj.Free; end;
  for J := Low(RequiredFiles) to High(RequiredFiles) do
    if not PHYSFS_exists(RequiredFiles[J]) then Exit(SIM_MISSING);
  SetExceptionMask([exInvalidOp,exDenormalized,exZeroDivide,exOverflow,exUnderflow,exPrecision]);
  DefaultFormatSettings.DecimalSeparator := '.';
  SimResetOriginalRNG(SeedLo);
  SetRandomPolicy(Keyed,SeedLo,SeedHi);
  if not CvarsReady then begin CvarInit; CvarsReady := True; end;
  AIEnabled:=EnableAI;bots_difficulty.SetValue(Difficulty);bots_chat.SetValue(False);
  sv_gamemode.SetValue(Mode);
  sv_bonus_frequency.SetValue(0); sv_survivalmode.SetValue(False);
  sv_realisticmode.SetValue(False); sv_lobby.SetValue(False);
  sc_enable.SetValue(False); log_enable.SetValue(False);
  demo_autorecord.SetValue(False); sv_timelimit.SetValue(360000);
  UserDirectory := ''; BaseDirectory := ''; ModDir := '';
  MainConsole.CountMax := 7;
  if DummyPlayer = nil then DummyPlayer := TPlayer.Create;
  ClearEntities;
  for J := 1 to MAIN_WEAPONS do WeaponActive[J] := 1;
  Ticks := 0; MainTickCounter := 0; ServerTickCounter := 0;
  PlayersNum := 0; BotsNum := 0; SpectatorsNum := 0;
  SinusCounter := 0; WaveRespawnCounter := 0; WaveRespawnTime := 0;
  VoteActive := False; VoteTimeRemaining := -1;
  for J := 1 to MAX_PLAYERS do
  begin
    SimWasJumping[J] := False; SimWasRunningLeft[J] := False;
    NoClientUpdateTime[J] := 0;
    SimChosenPrimary[J]:=NOWEAPON_NUM;SimChosenSecondary[J]:=NOWEAPON_NUM;
    SimLimboAvailable[J]:=False;SimBotOwned[J]:=False;
  end;
  LoadAnimObjects('');
  SimBindAnimationContent;
  Initialized := True; MapLoaded := False;
  SimEventsReset; SimResetRender; SimFXReset(SeedLo); SimFXAllowed:=True;
  CombatDiagnostics.Reset; CombatDiagnostics.Enabled:=TraceCombat;
  Result := SIM_OK;
end;
function sim_load_map(Name: Pointer; NameLength: LongWord): LongInt;
var S: AnsiString; Info: TMapInfo; J,K: Integer;
begin
  if not Initialized then Exit(SIM_NOT_INITIALIZED);
  SimInvalidateState;
  if not TextArgument(Name,NameLength,S) then Exit(SIM_INVALID);
  if MapLoaded then Exit(SIM_UNSUPPORTED);
  if not GetMapInfo(S,UserDirectory,Info) then Exit(SIM_MISSING);
  if not Map.LoadMap(Info) then Exit(SIM_MALFORMED);
  StartHealth := DEFAULT_HEALTH;
  LoadWeapons('weapons');
  { Original Server.StartServer weapon bookkeeping, before any bot Respawn. }
  WeaponsInGame:=0;
  for J:=1 to MAIN_WEAPONS do if WeaponActive[J]=1 then Inc(WeaponsInGame);
  for J:=1 to MAX_SPRITES do
    for K:=1 to PRIMARY_WEAPONS do WeaponSel[J,K]:=WeaponActive[K];
  MapChangeCounter := -60; BulletTimeTimer := -1; TimeLimitCounter := 360000;
  for J := 1 to MAX_PLAYERS do Sprite[J].Player := DummyPlayer;
  MapLoaded := True; SimResetRender;
  Result := SIM_OK;
end;
function JsonInteger(Obj: TJSONObject; const Key: string; DefaultValue: Int64; out Value: Int64): Boolean;
var D: TJSONData; X: Double;
begin
  D := Obj.Find(Key); Value := DefaultValue;
  if D = nil then Exit(True);
  if D.JSONType <> jtNumber then Exit(False);
  X := D.AsFloat;
  Result := not IsNan(X) and not IsInfinite(X) and (X >= Low(LongInt)) and (X <= High(LongInt)) and (Frac(X) = 0);
  if Result then Value := D.AsInt64;
end;
function JsonScalar(Obj:TJSONObject;const Key:string;DefaultValue:Single;out Value:Single):Boolean;
var D:TJSONData;X:Double;
begin
  D:=Obj.Find(Key);Value:=DefaultValue;if D=nil then Exit(True);
  if D.JSONType<>jtNumber then Exit(False);
  X:=D.AsFloat;Result:=not IsNan(X) and not IsInfinite(X) and (Abs(X)<=1000000);
  if Result then Value:=X;
end;
function CombatCommand(Obj:TJSONObject;const Kind:string):LongInt;
var S,W,Owner,Ammo,Target,Circle,Timeout,Frame,Secondary:Int64;
  Pos,Velocity:TVector2;HitM:Single;Index:Integer;Selection:string;
begin
  Result:=SIM_INVALID;
  if (Kind='weapon-choice') or (Kind='weapon-apply') then begin
    if not JsonInteger(Obj,'slot',0,S) or (S<1) or (S>MAX_PLAYERS) or not Sprite[S].Active then Exit;
    if (Sprite[S].Player.ControlMethod<>BOT) or not Sprite[S].Dummy then Exit(SIM_UNSUPPORTED);
    if not JsonInteger(Obj,'weapon',-1,W) or (W<0) or (W>255) or (WeaponNumToIndex(W)<1) or
      not JsonInteger(Obj,'secondaryWeapon',SimChosenSecondary[S],Secondary) or
      (Secondary<0) or (Secondary>255) or (WeaponNumToIndex(Secondary)<1) then Exit;
    if Kind='weapon-apply' then begin
      Selection:=Obj.Get('selection','primary');
      if (Selection<>'primary') and (Selection<>'secondary') then Exit(SIM_UNSUPPORTED);
      if not SimLimboAvailable[S] or Sprite[S].DeadMeat then Exit(SIM_UNSUPPORTED);
      if Selection='primary' then begin
        Index:=WeaponNumToIndex(W);
        if (Index<1) or (Index>PRIMARY_WEAPONS) or (WeaponActive[Index]<>1) or
          (Sprite[S].Weapon.Num in [BOW_NUM,BOW2_NUM]) then Exit(SIM_UNSUPPORTED);
      end else if Obj.Find('secondaryWeapon')=nil then Exit(SIM_INVALID);
      Index:=WeaponNumToIndex(Secondary);
      if (Obj.Find('secondaryWeapon')<>nil) and
        ((Index<COLT) or (Index>LAW) or (WeaponActive[Index]<>1)) then Exit(SIM_UNSUPPORTED);
      if Selection='primary' then begin
        SimLimboAvailable[S]:=False;
        Sprite[S].SelWeapon:=W;
        Sprite[S].ApplyWeaponByNum(W,1);
      end;
      if Obj.Find('secondaryWeapon')<>nil then begin
        Sprite[S].Player.SecWep:=Index-COLT;
        Sprite[S].ApplyWeaponByNum(Secondary,2);
      end;
      if Selection='secondary' then begin SimChosenSecondary[S]:=Secondary;Exit(SIM_OK);end;
    end;
    SimChosenPrimary[S]:=W;SimChosenSecondary[S]:=Secondary;Sprite[S].Brain.FavWeapon:=W;
    Exit(SIM_OK);
  end;
  if Kind='fixture-sprite' then begin
    if not CombatDiagnostics.Enabled then Exit(SIM_UNSUPPORTED);
    if not JsonInteger(Obj,'slot',0,S) or (S<1) or (S>MAX_PLAYERS) then Exit;
    if not Sprite[S].Active then Exit;
    if Obj.Get('bodyAnimation','')<>'Throw' then Exit(SIM_UNSUPPORTED);
    if not JsonInteger(Obj,'bodyFrame',0,Frame) or (Frame<1) or (Frame>Throw.NumFrames) then Exit;
    if not JsonInteger(Obj,'grenadeWeapon',FRAGGRENADE_NUM,W) or
      ((W<>FRAGGRENADE_NUM) and (W<>CLUSTERGRENADE_NUM)) then Exit;
    Sprite[S].BodyApplyAnimation(Throw,Frame);
    Sprite[S].GrenadeCanThrow:=False;Sprite[S].CeaseFireCounter:=-1;
    if Obj.Find('grenadeWeapon')<>nil then begin
      Sprite[S].TertiaryWeapon:=Guns[WeaponNumToIndex(W)];
      Sprite[S].TertiaryWeapon.AmmoCount:=3;
    end;
    Exit(SIM_OK);
  end;
  if not JsonScalar(Obj,'x',0,Pos.X) or not JsonScalar(Obj,'y',0,Pos.Y) then Exit;
  if not JsonInteger(Obj,'owner',0,Owner) or (Owner<0) or (Owner>MAX_PLAYERS) then Exit;
  if Kind='thing' then begin
    if not JsonInteger(Obj,'style',0,W) or (W<1) or (W>OBJECT_STATIONARY_GUN) then Exit;
    if not JsonInteger(Obj,'ammo',255,Ammo) or (Ammo<0) or (Ammo>255) then Exit;
    if CreateThing(Pos,Owner,W,Ammo)<1 then Exit(SIM_CAPACITY);
    Exit(SIM_OK);
  end;
  if Kind<>'bullet' then Exit(SIM_UNSUPPORTED);
  if not CombatDiagnostics.Enabled then Exit(SIM_UNSUPPORTED);
  if (Owner=0) or not Sprite[Owner].Active then Exit;
  if not JsonInteger(Obj,'weapon',-1,W) or (W<0) or (W>255) then Exit;
  Index:=WeaponNumToIndex(W);if (Index<1) or (Index>TOTAL_WEAPONS) then Exit;
  if not JsonInteger(Obj,'target',0,Target) or (Target<0) or (Target>MAX_PLAYERS) then Exit;
  if not JsonInteger(Obj,'hitCircle',0,Circle) then Exit;
  if Target<>0 then begin
    if not Sprite[Target].Active or not (Circle in [3,4,5,6,10,11,12]) then Exit;
    Pos.X:=Pos.X+Sprite[Target].Skeleton.Pos[Circle].X-2;
    Pos.Y:=Pos.Y+Sprite[Target].Skeleton.Pos[Circle].Y;
  end;
  if not JsonScalar(Obj,'vx',0,Velocity.X) or not JsonScalar(Obj,'vy',0,Velocity.Y) or
    not JsonScalar(Obj,'hitMultiply',Guns[Index].HitMultiply,HitM) then Exit;
  if not JsonInteger(Obj,'timeout',Guns[Index].Timeout,Timeout) or
    (Timeout<1) or (Timeout>High(SmallInt)) then Exit;
  Index:=CreateBullet(Pos,Velocity,W,Owner,255,HitM,False,True);
  if Index<1 then Exit(SIM_CAPACITY);
  if Obj.Find('timeout')<>nil then Bullet[Index].TimeOut:=Timeout;
  Result:=SIM_OK;
end;
function sim_command(Tick: LongWord; Data: Pointer; Length: LongWord): LongInt;
var Obj: TJSONObject; Kind, Key: string; S, Team, Spawn, Flag,W,Secondary,Ammo,Grenades: Int64;
  Position, Velocity: TVector2; P: TPlayer; J, Created: Integer; Health,Vest: Single; D: TJSONData;
  IsBot:Boolean;Profile:string;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  SimInvalidateState;
  if Tick <> LongWord(MainTickCounter) then Exit(SIM_INVALID);
  if not ReadObject(Data,Length,Obj) then Exit(SIM_MALFORMED);
  try
    D := Obj.Find('kind'); if (D = nil) or (D.JSONType <> jtString) then Exit(SIM_MALFORMED);
    Kind := D.AsString;
    if (Kind='thing') or (Kind='bullet') or (Kind='fixture-sprite') or (Kind='weapon-choice') or (Kind='weapon-apply') then Exit(CombatCommand(Obj,Kind));
    if (Kind <> 'join') and (Kind <> 'leave') and (Kind <> 'team') and (Kind <> 'spawn') then Exit(SIM_UNSUPPORTED);
    for J := 0 to Obj.Count-1 do
    begin
      Key := Obj.Names[J];
      if (Key <> 'kind') and (Key <> 'slot') and (Key <> 'team') and (Key <> 'spawn') and
         (Key <> 'x') and (Key <> 'y') and (Key <> 'health') and (Key <> 'heldFlag') and
         (Key <> 'weapon') and (Key <> 'secondaryWeapon') and (Key <> 'ammo') and
         (Key <> 'grenades') and (Key <> 'vest') and (Key <> 'control') and (Key <> 'bot') then Exit(SIM_UNSUPPORTED);
    end;
    if (Obj.Find('slot') = nil) or not JsonInteger(Obj,'slot',0,S) or (S < 1) or (S > MAX_PLAYERS) then Exit(SIM_INVALID);
    if not JsonInteger(Obj,'team',0,Team) or (Team < 0) or (Team > TEAM_SPECTATOR) then Exit(SIM_INVALID);
    if (Obj.Get('control','human')<>'human') and (Obj.Get('control','human')<>'authoritative') and
      (Obj.Get('control','human')<>'bot') then Exit(SIM_UNSUPPORTED);
    IsBot:=Obj.Get('control','human')='bot';
    Profile:='';
    if IsBot then begin
      D:=Obj.Find('bot');
      if (D=nil) or (D.JSONType<>jtString) or (D.AsString='') then Exit(SIM_INVALID);
      Profile:=LowerCase(D.AsString);
      if (Pos('/',Profile)>0) or (Pos('\',Profile)>0) or (Pos('..',Profile)>0) then Exit(SIM_INVALID);
      Profile:='bots/'+Profile+'.bot';
      if not PHYSFS_exists(PChar(Profile)) then Exit(SIM_MISSING);
    end;
    if not JsonInteger(Obj,'weapon',255,W) or (W<0) or (W>255) or
      not JsonInteger(Obj,'secondaryWeapon',255,Secondary) or (Secondary<0) or (Secondary>255) or
      not JsonInteger(Obj,'ammo',-1,Ammo) or (Ammo< -1) or (Ammo>255) or
      not JsonInteger(Obj,'grenades',-1,Grenades) or (Grenades< -1) or (Grenades>255) or
      not JsonScalar(Obj,'vest',0,Vest) or (Vest<0) then Exit(SIM_INVALID);
    if ((Obj.Find('weapon')<>nil) and (WeaponNumToIndex(W)<1)) or
      ((Obj.Find('secondaryWeapon')<>nil) and (WeaponNumToIndex(Secondary)<1)) then Exit(SIM_INVALID);
    if Kind = 'leave' then
    begin
      if not Sprite[S].Active then Exit(SIM_INVALID);
      Sprite[S].Kill; SimResetRender; Exit(SIM_OK);
    end;
    if Kind = 'team' then
    begin
      if not Sprite[S].Active or (Obj.Find('team') = nil) then Exit(SIM_INVALID);
      Sprite[S].ChangeTeam(Team,True); SimResetRender; Exit(SIM_OK);
    end;
    if (Kind = 'join') and Sprite[S].Active then Exit(SIM_INVALID);
    if (Kind = 'spawn') and not Sprite[S].Active then Exit(SIM_INVALID);
    if not JsonInteger(Obj,'spawn',1,Spawn) or (Spawn < 1) or (Spawn > MAX_SPAWNPOINTS) then Exit(SIM_INVALID);
    if not Map.Spawnpoints[Spawn].Active then Exit(SIM_MISSING);
    Position.X := Map.Spawnpoints[Spawn].X; Position.Y := Map.Spawnpoints[Spawn].Y;
    Health := StartHealth;
    for J := 0 to 2 do
    begin
      case J of 0: Key := 'x'; 1: Key := 'y'; else Key := 'health'; end;
      D := Obj.Find(Key);
      if D <> nil then
      begin
        if D.JSONType <> jtNumber then Exit(SIM_MALFORMED);
        if IsNan(D.AsFloat) or IsInfinite(D.AsFloat) or (Abs(D.AsFloat) > 1000000) then Exit(SIM_INVALID);
        case J of 0: Position.X := D.AsFloat; 1: Position.Y := D.AsFloat; else Health := D.AsFloat; end;
      end;
    end;
    if not JsonInteger(Obj,'heldFlag',0,Flag) or (Flag < 0) or (Flag > 3) then Exit(SIM_INVALID);
    if Flag <> 0 then
    begin
      Created := 0;
      for J := 1 to MAX_THINGS do if not Thing[J].Active then begin Created := J; Break; end;
      if Created = 0 then Exit(SIM_CAPACITY);
    end;
    Velocity := Default(TVector2);
    if Kind = 'join' then
    begin
      P := TPlayer.Create; P.Team := Team; P.ControlMethod := HUMAN;
      P.Name := 'oracle-' + IntToStr(S);
      if Obj.Get('control','human')='authoritative' then begin
        P.ControlMethod:=BOT;
      end;
      if IsBot then begin
        P.ApplyShirtColorFromTeam;
        RandomizeStart(Position,Team);
      end;
    end
    else P := Sprite[S].Player;
    Created := CreateSprite(Position,Velocity,1,S,P,True);
    if Created <> S then Exit(SIM_CAPACITY);
    SimLimboAvailable[S]:=True;
    if Kind='join' then SimBotOwned[S]:=IsBot;
    if IsBot then begin
      if not LoadBotConfig(Profile,Sprite[S]) then begin Sprite[S].Kill;Exit(SIM_MALFORMED);end;
      Sprite[S].Respawn;
      Sprite[S].Player.ChatWarnings:=0;Sprite[S].Player.GrabsPerSecond:=0;
      SortPlayers;SimResetRender;Exit(SIM_OK);
    end;
    Sprite[S].Health := Health;
    if P.ControlMethod=BOT then begin
      if Kind='join' then begin
        SimChosenPrimary[S]:=W;SimChosenSecondary[S]:=Secondary;
        if Obj.Find('weapon')=nil then SimChosenPrimary[S]:=Sprite[S].Weapon.Num;
        if Obj.Find('secondaryWeapon')=nil then SimChosenSecondary[S]:=Sprite[S].SecondaryWeapon.Num;
      end;
      Sprite[S].Dummy:=True;Sprite[S].Brain.Use:=255;Sprite[S].Brain.FavWeapon:=SimChosenPrimary[S];
      if Kind='spawn' then begin
        Sprite[S].ApplyWeaponByNum(SimChosenPrimary[S],1);Sprite[S].ApplyWeaponByNum(SimChosenSecondary[S],2);
      end;
    end;
    if Obj.Find('weapon')<>nil then Sprite[S].ApplyWeaponByNum(W,1,Ammo);
    if Obj.Find('secondaryWeapon')<>nil then Sprite[S].ApplyWeaponByNum(Secondary,2);
    if Grenades>=0 then Sprite[S].TertiaryWeapon.AmmoCount:=Grenades;
    Sprite[S].Vest:=Vest;
    if Flag <> 0 then
    begin
      Created := CreateThing(Position,S,Flag,255);
      if Created < 1 then Exit(SIM_CAPACITY);
      Thing[Created].HoldingSprite := S; Sprite[S].HoldedThing := Created;
    end;
    SimResetRender; Result := SIM_OK;
  finally Obj.Free; end;
end;
function Read16(Data: PByte; Offset: Integer): Word;
begin Result := Word(Data[Offset]) or (Word(Data[Offset+1]) shl 8); end;
function sim_set_input(Slot, Tick: LongWord; Data: Pointer): LongInt;
var Bits, Order: Word; C: TControl;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  SimInvalidateState;
  if (Slot < 1) or (Slot > MAX_PLAYERS) or not Sprite[Slot].Active or
    (Tick <> LongWord(MainTickCounter)) or (Data = nil) then Exit(SIM_INVALID);
  Bits := Read16(Data,0); Order := Read16(Data,8);
  if (Bits and $F000 <> 0) or (Order and $FFF0 <> 0) or (Read16(Data,10) <> 0) or
     ((Order and 3) = 3) or ((Order and 12) = 12) then Exit(SIM_INVALID);
  C := Default(TControl);
  C.Left := Bits and 1 <> 0; C.Right := Bits and 2 <> 0;
  C.Up := Bits and 4 <> 0; C.Down := Bits and 8 <> 0;
  C.Fire := Bits and 16 <> 0; C.Jetpack := Bits and 32 <> 0;
  C.ThrowNade := Bits and 64 <> 0; C.ChangeWeapon := Bits and 128 <> 0;
  C.ThrowWeapon := Bits and 256 <> 0; C.Reload := Bits and 512 <> 0;
  C.Prone := Bits and 1024 <> 0; C.FlagThrow := Bits and 2048 <> 0;
  C.MouseAimX := SmallInt(Read16(Data,2)); C.MouseAimY := SmallInt(Read16(Data,4));
  C.MouseDist := SmallInt(Read16(Data,6));
  if C.Left and C.Right then
  begin
    { Zero order means already resolved server controls, not client sampling. }
    if Order <> 0 then
    begin
      if Order and 3 <> 0 then SimWasRunningLeft[Slot] := Order and 1 <> 0;
      if SimWasJumping[Slot] then C.Left := SimWasRunningLeft[Slot]
      else C.Left := not SimWasRunningLeft[Slot];
      C.Right := not C.Left;
    end;
  end
  else
  begin
    SimWasRunningLeft[Slot] := C.Left; SimWasJumping[Slot] := C.Up;
  end;
  Sprite[Slot].Control := C; NoClientUpdateTime[Slot] := 0;
  Result := SIM_OK;
end;
procedure Stage(const Name: string; Entity: Integer = 0);
begin if Assigned(SimTraceHook) then SimTraceHook(Name,Entity); end;
procedure UpdateMovementFrame;
var I,J,_x: Integer; M: TVector2;
begin
  M := Default(TVector2);
  { Original human release/burst guard at the injected-input boundary. }
  for J:=1 to MAX_PLAYERS do if Sprite[J].Active and Sprite[J].Dummy and
    (Sprite[J].Player.ControlMethod=BOT) then begin
    Sprite[J].Brain.FavWeapon:=SimChosenPrimary[J];
    if not Sprite[J].Control.Fire then Sprite[J].BurstCount:=0;
    if (Sprite[J].Weapon.FireMode=2) and Sprite[J].Control.Fire and
      ((Sprite[J].BurstCount>0) or Sprite[J].Control.Reload) and
      (Sprite[J].Weapon.FireIntervalCount<2) then Inc(Sprite[J].Weapon.FireIntervalCount);
  end;
  if MapChangeCounter < 0 then
  begin
    for J := 1 to MAX_SPRITES do
      if Sprite[J].Active and not Sprite[J].DeadMeat and Sprite[J].IsNotSpectator then
      begin
        for I := MAX_OLDPOS downto 1 do OldSpritePos[J,I] := OldSpritePos[J,I-1];
        OldSpritePos[J,0] := SpriteParts.Pos[J];
      end;
    for J := 1 to MAX_SPRITES do
      if Sprite[J].Active and Sprite[J].IsNotSpectator then SpriteParts.DoEulerTimeStepFor(J);
    Stage('sprite-parts');
    for J := 1 to MAX_SPRITES do if Sprite[J].Active then begin
      BeginRandomEvent(J,1);
      try Sprite[J].Update; finally EndRandomEvent; end;
      Stage('sprite',J);
    end;
    for J := 1 to MAX_BULLETS do if Bullet[J].Active then begin
      BeginRandomEvent(Bullet[J].Owner,$10000+Bullet[J].Seed);
      try Bullet[J].Update; finally EndRandomEvent; end;
    end;
    Stage('bullets');
    BulletParts.DoEulerTimeStep; Stage('bullet-parts');
    for J := 1 to MAX_THINGS do if Thing[J].Active then begin
      BeginRandomEvent(Thing[J].Owner,$20000+Thing[J].Style);
      try Thing[J].Update; finally EndRandomEvent; end;
    end;
    Stage('things');
  end;
  { Original ServerLoop.UpdateFrame remainder for supported normal DM/CTF rules.
    Bonus spawning is disabled at init; networking, logs and UI are not gameplay. }
  if BulletTimeTimer > -1 then Dec(BulletTimeTimer);
  if BulletTimeTimer = 0 then begin ToggleBulletTime(False); BulletTimeTimer := -1; end
  else if BulletTimeTimer < 1 then
  begin
    if (MapChangeCounter > -60) and (MapChangeCounter < 99999999) then Dec(MapChangeCounter);
    if (MapChangeCounter < 0) and (MapChangeCounter > -59) then ChangeMap;
    // Original ServerLoop.UpdateFrame anti-mass-flag branch.
    if MainTickCounter mod SECOND = 0 then
      if sv_antimassflag.Value then
        for j := 1 to MAX_SPRITES do
        begin
          if (Sprite[j].Active) and (Sprite[j].Player.GrabsPerSecond > 0) and
            (Sprite[j].Player.ScoresPerSecond > 0) and
            (Sprite[j].Player.GrabbedInBase) then
          begin
            CheatTag[j] := 1;
            StartVote(255, VOTE_KICK, IntToStr(j),
              'Server: Possible cheating');
            ServerSendVoteOn(VoteType, 255, IntToStr(j),
              'Server: Possible cheating');
            MainConsole.Console('** Detected possible Mass-Flag cheating from ' +
              Sprite[j].Player.Name, WARNING_MESSAGE_COLOR);
          end;

          if Sprite[j].Active then
          begin
            Sprite[j].Player.GrabsPerSecond := 0;
            Sprite[j].Player.ScoresPerSecond := 0;
            Sprite[j].Player.GrabbedInBase := False;
          end;
        end;
    if sv_healthcooldown.Value > 0 then
      if MainTickCounter mod (sv_healthcooldown.Value*SECOND) = 0 then
        for J := 1 to MAX_SPRITES do if Sprite[J].Active and Sprite[J].HasPack then Sprite[J].HasPack := False;
    // Original chat-warning cadence; host admission owns ban persistence.
    if MainTickCounter mod SECOND = 0 then
      for j := 1 to MAX_SPRITES do
        if Sprite[j].Active then
        begin
          if Sprite[j].Player.ChatWarnings > 5 then
            KickPlayer(j, True, KICK_FLOODING, FIVE_MINUTES, 'Chat Flood');
          if Sprite[j].Player.ChatWarnings > 0 then
            Dec(Sprite[j].Player.ChatWarnings);
        end;
    if MainTickCounter mod MINUTE = 0 then
      for J := 1 to MAX_SPRITES do if Sprite[J].Active then Inc(Sprite[J].Player.PlayTime);
    if MainTickCounter mod (SECOND*10) = 0 then
      if (PlayersNum = 0) and (MapChangeCounter > 99999999) then MapChangeCounter := -60;
    SinusCounter := SinusCounter + ILUMINATESPEED;
    Dec(WaveRespawnCounter); if WaveRespawnCounter < 1 then WaveRespawnCounter := WaveRespawnTime;
    for J := 1 to MAX_SPRITES do if VoteCooldown[J] > -1 then Dec(VoteCooldown[J]);
    if (MapChangeCounter < 99999999) and (TimeLimitCounter > 0) then Dec(TimeLimitCounter);
    if TimeLimitCounter = 1 then NextMap;
    TimeLeftMin := TimeLimitCounter div MINUTE;
    TimeLeftSec := (TimeLimitCounter-TimeLeftMin*MINUTE) div 60;
    TimerVote;
    if not sv_advancemode.Value then
      for J := 1 to MAX_SPRITES do for I := 1 to 10 do WeaponSel[J,I] := 1;
  end;
  if PlayersTeamNum[2] = PlayersTeamNum[1] then HTFTime := sv_htf_pointstime.Value*60;
  { Original ServerLoop.UpdateFrame: destroy duplicate flags and recreate absent
    flags every two seconds. Keep the source ordering and RNG consumption. }
  if (sv_gamemode.Value = GAMESTYLE_CTF) or (sv_gamemode.Value = GAMESTYLE_INF) then
    if MainTickCounter mod (SECOND * 2) = 0 then
    begin
      _x := 0;

      for j := 1 to MAX_THINGS do
        if Thing[j].Active then
          if Thing[j].Style = OBJECT_ALPHA_FLAG then
            Inc(_x);

      if _x > 1 then
        for j := MAX_THINGS downto 1 do
          if Thing[j].Active then
            if Thing[j].Style = OBJECT_ALPHA_FLAG then
            begin
              Thing[j].Kill;
              Break;
            end;

      if _x = 0 then
        if RandomizeStart(M, 5) then
          TeamFlag[1] := CreateThing(M, 255, OBJECT_ALPHA_FLAG, 255);

      _x := 0;

      for j := 1 to MAX_THINGS do
        if Thing[j].Active then
          if Thing[j].Style = OBJECT_BRAVO_FLAG then
            Inc(_x);

      if _x > 1 then
        for j := MAX_THINGS downto 1 do
          if Thing[j].Active then
            if Thing[j].Style = OBJECT_BRAVO_FLAG then
            begin
              Thing[j].Kill;
              Break;
            end;

      if _x = 0 then
        if RandomizeStart(M, 6) then
          TeamFlag[2] := CreateThing(M, 255, OBJECT_BRAVO_FLAG, 255);
    end;
end;
function sim_step(Flags: LongWord): LongInt;
var J: Integer; WasDead:TSimInputHistory;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  SimInvalidateState;
  if Flags and not LongWord(1) <> 0 then Exit(SIM_UNSUPPORTED);
  SimCapturePreviousPose;
  Inc(Ticks); Inc(ServerTickCounter); Inc(MainTickCounter);
  if MainTickCounter = 2147483640 then MainTickCounter := 0;
  SimEventsSetTick(MainTickCounter); SimEventsSetReplay(Flags and 1 <> 0);
  SimFXAllowed := Flags and 1 = 0;
  SimFXReplay(not SimFXAllowed);
  for J := 1 to MAX_SPRITES do if Sprite[J].Active then NoClientUpdateTime[J] := 0;
  for J:=1 to MAX_PLAYERS do WasDead[J]:=Sprite[J].DeadMeat;
  try
    try
      UpdateMovementFrame;
      for J:=1 to MAX_PLAYERS do if WasDead[J] and Sprite[J].Active and not Sprite[J].DeadMeat and
        Sprite[J].Dummy and (Sprite[J].Player.ControlMethod=BOT) then begin
        Sprite[J].ApplyWeaponByNum(SimChosenPrimary[J],1);
        Sprite[J].ApplyWeaponByNum(SimChosenSecondary[J],2);
        SimLimboAvailable[J]:=True;
      end;
      Stage('tick');
    except
      on E: ESimEventOverflow do Exit(SIM_CAPACITY);
      on E: ENotSupportedException do Exit(SIM_UNSUPPORTED);
    end;
  finally
    SimEventsSetReplay(False);
  end;
  Result := MainTickCounter;
end;
function sim_events(Buffer: Pointer; Capacity: LongWord): LongInt;
begin
  if not Initialized then Exit(SIM_NOT_INITIALIZED);
  if (Buffer = nil) and (Capacity <> 0) then Exit(SIM_INVALID);
  Result := SimEventsRead(Buffer,Capacity);
end;
function sim_render_view: Pointer;
begin if not Initialized or not MapLoaded then Result := nil else Result := SimRenderView; end;
function sim_save_state(Buffer: Pointer; Capacity: LongWord): LongInt;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  Result := SimSaveState(Buffer,Capacity);
end;
function sim_load_state(Buffer: Pointer; Length: LongWord): LongInt;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  Result := SimLoadState(Buffer,Length);
end;
function sim_hash_state: QWord;
begin if not Initialized or not MapLoaded then Result := 0 else Result := SimHashState; end;
function sim_trace_state(Buffer: Pointer; Capacity: LongWord): LongInt;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  CurrentTick := MainTickCounter; TraceOpen := True;
  try
    if CurrentTick = 0 then OracleDump('initial',0) else OracleDump('tick',0);
  finally TraceOpen := False; end;
  Result := Length(SimTraceRow);
  if (Buffer = nil) and (Capacity = 0) then Exit;
  if Buffer = nil then Exit(SIM_INVALID);
  if Capacity < LongWord(Result) then Exit(SIM_CAPACITY);
  if Result <> 0 then Move(SimTraceRow[1],Buffer^,Result);
end;
function fx_step: LongInt;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  Result := SimFXStep;
end;
function fx_render_view: LongInt;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  Result := PtrUInt(SimFXRenderView);
end;
function fx_set_view(X,Y,Width,Height:Single;Slot:LongWord):LongInt;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  if IsNan(X) or IsNan(Y) or IsNan(Width) or IsNan(Height) or
    IsInfinite(X) or IsInfinite(Y) or IsInfinite(Width) or IsInfinite(Height) or
    (Width<=0) or (Height<=0) or (Width>16384) or (Height>16384) or (Slot>MAX_PLAYERS) then Exit(SIM_INVALID);
  SimFXSetView(X,Y,Width,Height);
  SimPresentation.CameraX:=X; SimPresentation.CameraY:=Y;
  SimPresentation.GameWidth:=Width; SimPresentation.GameHeight:=Height;
  SimPresentation.MySprite:=Slot; SimPresentation.CameraFollowSprite:=Slot;
  Result:=SIM_OK;
end;
end.
