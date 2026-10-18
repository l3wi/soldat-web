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
  SimPresentation, CombatDiagnostics, SharedConfig, ServerHelper, Control;
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
var J,K,N: Integer; Name: AnsiString; Value: TJSONData;
begin
  Result := False;
  for J := 0 to Obj.Count-1 do
  begin
    Name := Obj.Names[J]; Value := Obj.Items[J];
    if Name = 'mode' then begin
      if (Value.JSONType <> jtString) or
        ((Value.AsString<>'dm') and (Value.AsString<>'pm') and
         (Value.AsString<>'tm') and (Value.AsString<>'ctf') and
         (Value.AsString<>'rambo') and (Value.AsString<>'inf') and
         (Value.AsString<>'htf')) then Exit;
    end
    else if Name = 'rng' then begin
      if (Value.JSONType <> jtString) or ((Value.AsString <> 'original') and (Value.AsString <> 'keyed')) then Exit;
    end
    else if Name='world' then begin
      if (Value.JSONType<>jtString) or ((Value.AsString<>'original') and (Value.AsString<>'fixture')) then Exit;
    end
    else if (Name='stationaryGuns') or (Name='ai') or (Name='realistic') or
      (Name='survival') or (Name='advance') or (Name='bulletTime') or
      (Name='friendlyFire') or (Name='balanceTeams') or (Name='sniperLine') or (Name='traceCombat') or
      (Name='bonusFlamer') or (Name='bonusPredator') or (Name='bonusBerserker') or
      (Name='bonusVest') or (Name='bonusCluster') then begin
      if Value.JSONType<>jtBoolean then Exit;
    end
    else if Name='weapons' then begin
      if Value.JSONType<>jtArray then Exit;
      if Value.Count>MAIN_WEAPONS then Exit;
      for K:=0 to Value.Count-1 do begin
        if (Value.Items[K].JSONType<>jtNumber) or (Frac(Value.Items[K].AsFloat)<>0) or
          (Value.Items[K].AsFloat<0) or (Value.Items[K].AsFloat>255) then Exit;
        { Rules are validated before CreateWeapons initializes the gun table. }
        N:=Value.Items[K].AsInteger;
        if (N<0) or (N>LAW_NUM) then Exit;
      end;
    end
    else begin
      if (Value.JSONType<>jtNumber) or IsNan(Value.AsFloat) or IsInfinite(Value.AsFloat) or
        (Frac(Value.AsFloat)<>0) then Exit;
      if Name='botDifficulty' then begin if (Value.AsFloat<0) or (Value.AsFloat>300) then Exit;end
      else if Name='bonusFrequency' then begin if (Value.AsFloat<0) or (Value.AsFloat>5) then Exit;end
      else if Name='advanceAmount' then begin if (Value.AsFloat<1) or (Value.AsFloat>9999) then Exit;end
      else if Name='timeLimitTicks' then begin if (Value.AsFloat<0) or (Value.AsFloat>High(LongInt)) then Exit;end
      else if Name='scoreLimit' then begin if (Value.AsFloat<0) or (Value.AsFloat>9999) then Exit;end
      else if Name='tickRate' then begin if Value.AsFloat<>60 then Exit;end
      else Exit;
    end;
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
var Obj: TJSONObject; J,K,Mode,Difficulty: Integer; Keyed,TraceCombat,EnableAI,OriginalWorld,Stationary:Boolean;
  ModeName:string; Enabled:TJSONData;
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
    ModeName:=Obj.Get('mode','dm');
    if ModeName='pm' then Mode:=GAMESTYLE_POINTMATCH
    else if ModeName='tm' then Mode:=GAMESTYLE_TEAMMATCH
    else if ModeName='ctf' then Mode:=GAMESTYLE_CTF
    else if ModeName='rambo' then Mode:=GAMESTYLE_RAMBO
    else if ModeName='inf' then Mode:=GAMESTYLE_INF
    else if ModeName='htf' then Mode:=GAMESTYLE_HTF;
    TraceCombat:=Obj.Get('traceCombat',False);
    EnableAI:=Obj.Get('ai',False);Difficulty:=Obj.Get('botDifficulty',100);
    OriginalWorld:=Obj.Get('world','original')='original';Stationary:=Obj.Get('stationaryGuns',False);
    if not CvarsReady then begin CvarInit; CvarsReady:=True;end;
    sv_realisticmode.SetValue(Obj.Get('realistic',False));
    sv_survivalmode.SetValue(Obj.Get('survival',False));
    sv_advancemode.SetValue(Obj.Get('advance',False));
    sv_advancemode_amount.SetValue(Obj.Get('advanceAmount',2));
    sv_bullettime.SetValue(Obj.Get('bulletTime',False));
    sv_friendlyfire.SetValue(Obj.Get('friendlyFire',False));
    sv_balanceteams.SetValue(Obj.Get('balanceTeams',False));
    sv_sniperline.SetValue(Obj.Get('sniperLine',False));
    sv_bonus_frequency.SetValue(Obj.Get('bonusFrequency',0));
    sv_bonus_flamer.SetValue(Obj.Get('bonusFlamer',True));
    sv_bonus_predator.SetValue(Obj.Get('bonusPredator',True));
    sv_bonus_berserker.SetValue(Obj.Get('bonusBerserker',True));
    sv_bonus_vest.SetValue(Obj.Get('bonusVest',True));
    sv_bonus_cluster.SetValue(Obj.Get('bonusCluster',True));
    SimTimeLimitTicks:=Obj.Get('timeLimitTicks',360000);
    SimScoreLimit:=Obj.Get('scoreLimit',0);
    for J:=1 to MAIN_WEAPONS do WeaponActive[J]:=1;
    Enabled:=Obj.Find('weapons');
    if Enabled<>nil then begin
      for J:=1 to MAIN_WEAPONS do WeaponActive[J]:=0;
      for J:=0 to Enabled.Count-1 do begin
        { Selectable original numbers are 1..10, then Colt 0, knife 11,
          chainsaw 12 and LAW 13. The gun records are loaded with the map. }
        K:=Enabled.Items[J].AsInteger;
        if K=COLT_NUM then K:=COLT
        else if K>=KNIFE_NUM then Inc(K);
        WeaponActive[K]:=1;
      end;
    end;
  finally Obj.Free; end;
  for J := Low(RequiredFiles) to High(RequiredFiles) do
    if not PHYSFS_exists(RequiredFiles[J]) then Exit(SIM_MISSING);
  SetExceptionMask([exInvalidOp,exDenormalized,exZeroDivide,exOverflow,exUnderflow,exPrecision]);
  DefaultFormatSettings.DecimalSeparator := '.';
  SimResetOriginalRNG(SeedLo);
  SetRandomPolicy(Keyed,SeedLo,SeedHi);
  AIEnabled:=EnableAI;bots_difficulty.SetValue(Difficulty);bots_chat.SetValue(False);
  SimOriginalWorld:=OriginalWorld;sv_stationaryguns.SetValue(Stationary);
  sv_gamemode.SetValue(Mode);
  sv_lobby.SetValue(False);
  sc_enable.SetValue(False); log_enable.SetValue(False);
  demo_autorecord.SetValue(False);
  sv_timelimit.SetValue(SimTimeLimitTicks);
  sv_killlimit.SetValue(SimScoreLimit);
  UserDirectory := ''; BaseDirectory := ''; ModDir := '';
  MainConsole.CountMax := 7;
  if DummyPlayer = nil then DummyPlayer := TPlayer.Create;
  ClearEntities;
  FillChar(SimVisibility,SizeOf(SimVisibility),0);
  SimRoundEpoch:=0;SimRoundReady:=False;
  Ticks := 0; MainTickCounter := 0; ServerTickCounter := 0;
  PlayersNum := 0; BotsNum := 0; SpectatorsNum := 0;
  SinusCounter := 0; WaveRespawnCounter := 0; WaveRespawnTime := 0;
  VoteActive := False; VoteTimeRemaining := -1;
  for J := 1 to MAX_PLAYERS do
  begin
    SimWasJumping[J] := False; SimWasRunningLeft[J] := False;
    NoClientUpdateTime[J] := 0;
    SimChosenPrimary[J]:=NOWEAPON_NUM;SimChosenSecondary[J]:=NOWEAPON_NUM;
    SimLimboAvailable[J]:=False;SimBotOwned[J]:=False;SimCustomShirt[J]:=$00304289;
  end;
  LoadAnimObjects('');
  SimBindAnimationContent;
  Initialized := True; MapLoaded := False;
  SimEventsReset; SimResetRender; SimFXReset(SeedLo); SimFXAllowed:=True;
  CombatDiagnostics.Reset; CombatDiagnostics.Enabled:=TraceCombat;
  Result := SIM_OK;
end;
procedure SpawnOriginalWorld;
var A:TVector2;I:Integer;
begin
  A:=Default(TVector2);
  if sv_gamemode.Value in [GAMESTYLE_POINTMATCH,GAMESTYLE_HTF] then begin
    RandomizeStart(A,14);TeamFlag[1]:=CreateThing(A,255,OBJECT_POINTMATCH_FLAG,255);
  end;
  if sv_gamemode.Value in [GAMESTYLE_CTF,GAMESTYLE_INF] then begin
    if RandomizeStart(A,5) then TeamFlag[1]:=CreateThing(A,255,OBJECT_ALPHA_FLAG,255);
    if RandomizeStart(A,6) then TeamFlag[2]:=CreateThing(A,255,OBJECT_BRAVO_FLAG,255);
  end;
  if sv_gamemode.Value=GAMESTYLE_RAMBO then begin
    RandomizeStart(A,15);CreateThing(A,255,OBJECT_RAMBO_BOW,255);
  end;
  if not sv_survivalmode.Value then begin
    SpawnThings(OBJECT_MEDICAL_KIT,Map.Medikits);
    if sv_maxgrenades.Value>0 then SpawnThings(OBJECT_GRENADE_KIT,Map.Grenades);
  end;
  if sv_stationaryguns.Value then
    for I:=1 to MAX_SPAWNPOINTS do
      if Map.SpawnPoints[I].Active and (Map.SpawnPoints[I].Team=16) then begin
        A.X:=Map.SpawnPoints[I].X;A.Y:=Map.SpawnPoints[I].Y;
        CreateThing(A,255,OBJECT_STATIONARY_GUN,255);
      end;
end;
function sim_load_map(Name: Pointer; NameLength: LongWord): LongInt;
var S: AnsiString; Info: TMapInfo; J,K: Integer; Transition:Boolean;
begin
  if not Initialized then Exit(SIM_NOT_INITIALIZED);
  SimInvalidateState;
  if not TextArgument(Name,NameLength,S) then Exit(SIM_INVALID);
  Transition:=MapLoaded;
  { Joining replicas may still be catching up the countdown. The authoritative
    host only transitions at ready; loadMap is an explicit epoch boundary and
    accepts it at any tick so a repeated welcome can install that same map. }
  if not GetMapInfo(S,UserDirectory,Info) then Exit(SIM_MISSING);
  if not Map.LoadMap(Info) then Exit(SIM_MALFORMED);
  if sv_realisticmode.Value then begin StartHealth:=REALISTIC_HEALTH;LoadWeapons('weapons_realistic');end
  else begin StartHealth:=DEFAULT_HEALTH;LoadWeapons('weapons');end;
  { Original Server.StartServer weapon bookkeeping, before any bot Respawn. }
  WeaponsInGame:=0;
  for J:=1 to MAIN_WEAPONS do if WeaponActive[J]=1 then Inc(WeaponsInGame);
  for J:=1 to MAX_SPRITES do
    for K:=1 to PRIMARY_WEAPONS do WeaponSel[J,K]:=WeaponActive[K];
  if sv_advancemode.Value then
    for J:=1 to MAX_SPRITES do for K:=1 to PRIMARY_WEAPONS do
      if Transition then WeaponSel[J,K]:=0 else WeaponSel[J,K]:=1;
  MapChangeCounter:=-60;BulletTimeTimer:=-1;ToggleBulletTime(False);
  TimeLimitCounter:=SimTimeLimitTicks;SimRoundReady:=False;
  SurvivalEndRound:=False;WeaponsCleaned:=False;AliveNum:=0;
  for J:=0 to 5 do begin TeamScore[J]:=0;TeamAliveNum[J]:=0;end;
  for J:=0 to 4 do TeamFlag[J]:=0;
  if Transition then begin
    Inc(SimRoundEpoch);
    for J:=1 to MAX_BULLETS do Bullet[J].Kill;
    for J:=1 to MAX_THINGS do Thing[J].Kill;
    FillChar(SimVisibility,SizeOf(SimVisibility),0);
    SimFXClear;
    for J:=1 to MAX_PLAYERS do if Sprite[J].Active then begin
      Sprite[J].Player.Kills:=0;Sprite[J].Player.Deaths:=0;Sprite[J].Player.Flags:=0;
      Sprite[J].HoldedThing:=0;Sprite[J].BonusTime:=0;Sprite[J].BonusStyle:=BONUS_NONE;
      Sprite[J].FreeControls;
      if Sprite[J].IsNotSpectator then begin
        Sprite[J].DeadMeat:=False;Sprite[J].Respawn;
        if not SimBotOwned[J] then begin
          SimApplyLoadout(J);SimLimboAvailable[J]:=True;
        end;
      end;
    end;
    SimEventsReset;SimEventsSetTick(MainTickCounter);
  end;
  if SimOriginalWorld then SpawnOriginalWorld;
  SortPlayers;
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
function AppearanceCommand(Obj:TJSONObject;Slot:Integer;Apply:Boolean):Boolean;
const Names:array[0..7] of string=('shirtColor','pantsColor','skinColor','hairColor','jetColor',
  'hairStyle','headStyle','chainStyle');
var D:TJSONData;A:TJSONObject;J,K:Integer;V:Int64;Values:array[0..7] of LongWord;P:TPlayer;
begin
  Result:=False;D:=Obj.Find('appearance');
  if D=nil then Exit(True);
  if D.JSONType<>jtObject then Exit;
  A:=TJSONObject(D);
  for J:=0 to A.Count-1 do begin
    K:=0;while (K<=High(Names)) and (A.Names[J]<>Names[K]) do Inc(K);
    if K>High(Names) then Exit;
  end;
  for J:=0 to High(Names) do begin
    if A.Find(Names[J])=nil then Exit;
    if not JsonInteger(A,Names[J],0,V) or (V<0) then Exit;
    if J<5 then begin if V>$FFFFFF then Exit;end
    else if J=5 then begin if V>4 then Exit;end
    else if V>2 then Exit;
    Values[J]:=V;
  end;
  if Apply then begin
    P:=Sprite[Slot].Player;
    SimCustomShirt[Slot]:=Values[0] or $FF000000;
    P.ShirtColor:=SimCustomShirt[Slot];P.PantsColor:=Values[1] or $FF000000;
    P.SkinColor:=Values[2] or $FF000000;P.HairColor:=Values[3] or $FF000000;
    P.JetColor:=Values[4] or $FF000000;P.HairStyle:=Values[5];P.Chain:=Values[7];
    case Values[6] of
      0:P.HeadCap:=0;1:P.HeadCap:=GFX_GOSTEK_HELM;2:P.HeadCap:=GFX_GOSTEK_KAP;
    end;
    P.ApplyShirtColorFromTeam;
    Sprite[Slot].WearHelmet:=Ord(P.HeadCap<>0);
  end;
  Result:=True;
end;
function TeamSupported(Team:Integer):Boolean;
begin
  Result:=Team=TEAM_SPECTATOR;
  if IsTeamGame then begin
    if sv_gamemode.Value=GAMESTYLE_TEAMMATCH then Result:=Result or (Team in [1..4])
    else Result:=Result or (Team in [1..2]);
  end else Result:=Result or (Team=TEAM_NONE);
end;
type TTeamPopulations = array[1..4] of Integer;
function PlayingTeams: Integer;
begin
  Result:=0;
  if IsTeamGame then
    if sv_gamemode.Value=GAMESTYLE_TEAMMATCH then Result:=4 else Result:=2;
end;
function CountTeams(out Counts:TTeamPopulations):Integer;
var I,T:Integer;
begin
  FillChar(Counts,SizeOf(Counts),0);Result:=PlayingTeams;
  for I:=1 to MAX_PLAYERS do
    if Sprite[I].Active then begin
      T:=Sprite[I].Player.Team;
      if (T>=1) and (T<=Result) then Inc(Counts[T]);
    end;
end;
function LowestPlayingTeam(Preferred:Integer):Integer;
var Counts:TTeamPopulations;I,N:Integer;
begin
  N:=CountTeams(Counts);Result:=1;
  if (Preferred>=1) and (Preferred<=N) then Result:=Preferred;
  for I:=1 to N do if Counts[I]<Counts[Result] then Result:=I;
end;
function BalancedTeamChange(Slot,Team:Integer):Boolean;
var Counts:TTeamPopulations;N,Old:Integer;
begin
  Result:=True;
  if not sv_balanceteams.Value or (Team=TEAM_SPECTATOR) then Exit;
  N:=CountTeams(Counts);if N=0 then Exit;
  Old:=Sprite[Slot].Player.Team;
  if Old=Team then Exit;
  if Old=TEAM_SPECTATOR then Result:=Counts[Team]=Counts[LowestPlayingTeam(Team)]
  else Result:=Counts[Team]<Counts[Old];
end;
procedure ChangePlayingTeam(Slot,Team:Integer);
var J:Integer;
begin
  { Original ChangeTeam owns drops, flag return, respawn and Survival death. }
  Sprite[Slot].ChangeTeam(Team,True);
  for J:=1 to MAX_PLAYERS do begin SimVisibility[Slot,J]:=0;SimVisibility[J,Slot]:=0;end;
  Sprite[Slot].Player.ShirtColor:=SimCustomShirt[Slot];Sprite[Slot].Player.ApplyShirtColorFromTeam;
  if not SimBotOwned[Slot] then begin
    Sprite[Slot].Dummy:=True;Sprite[Slot].Brain.Use:=255;Sprite[Slot].Brain.Camper:=0;
    if Sprite[Slot].IsNotSpectator then SimApplyLoadout(Slot);
    SimLimboAvailable[Slot]:=True;
  end;
end;
procedure BalancePlayingTeams;
var Counts:TTeamPopulations;N,I,Smallest,Largest,Slot,T:Integer;
begin
  if not sv_balanceteams.Value then Exit;
  N:=CountTeams(Counts);if N=0 then Exit;
  while True do begin
    Smallest:=1;Largest:=1;
    for I:=2 to N do begin
      if Counts[I]<Counts[Smallest] then Smallest:=I;
      if Counts[I]>Counts[Largest] then Largest:=I;
    end;
    if Counts[Largest]-Counts[Smallest]<=1 then Exit;
    Slot:=0;
    { Across tied largest teams, prefer a true AI bot, then stable slot order. }
    for I:=1 to MAX_PLAYERS do if Sprite[I].Active then begin
      T:=Sprite[I].Player.Team;
      if (T>=1) and (T<=N) then
        if Counts[T]=Counts[Largest] then
          if (Slot=0) or (SimBotOwned[I] and not SimBotOwned[Slot]) then Slot:=I;
    end;
    if Slot=0 then Exit;
    T:=Sprite[Slot].Player.Team;
    ChangePlayingTeam(Slot,Smallest);Dec(Counts[T]);Inc(Counts[Smallest]);
  end;
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
        if not SimWeaponAvailable(S,Index) or (Index>PRIMARY_WEAPONS) or
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
function PlayerActionCommand(Obj:TJSONObject;const Kind:string):LongInt;
var S:Int64;J,Idle:Integer;Key,Gesture:string;D:TJSONData;Velocity:TVector2;
begin
  Result:=SIM_INVALID;
  for J:=0 to Obj.Count-1 do begin
    Key:=Obj.Names[J];
    if (Key<>'kind') and (Key<>'slot') and
      ((Kind<>'gesture') or (Key<>'gesture')) then Exit(SIM_UNSUPPORTED);
  end;
  if (Obj.Find('slot')=nil) or not JsonInteger(Obj,'slot',0,S) or
    (S<1) or (S>MAX_PLAYERS) then Exit;
  if not Sprite[S].Active then Exit;
  if Sprite[S].DeadMeat or not Sprite[S].IsNotSpectator then Exit(SIM_UNSUPPORTED);
  if Kind='kill' then begin
    { Same damage, armour removal and score penalty as CommandPlayerCommand. }
    Velocity:=Default(TVector2);
    Sprite[S].Vest:=0;
    Sprite[S].HealthHit(150,S,1,-1,Velocity);
    if Sprite[S].Player.Kills>0 then Dec(Sprite[S].Player.Kills);
    SimResetRender;Exit(SIM_OK);
  end;
  D:=Obj.Find('gesture');
  if (D=nil) or (D.JSONType<>jtString) then Exit;
  Gesture:=D.AsString;
  if Gesture='tabac' then Idle:=0
  else if Gesture='smoke' then Idle:=1
  else if Gesture='takeoff' then Idle:=4
  else if Gesture='victory' then Idle:=5
  else Exit(SIM_UNSUPPORTED);
  { ControlSprite starts manual idle actions only from its standing countdown.
    Reject ineligible requests rather than arming a gesture for later respawn. }
  if (Sprite[S].Stat<>0) or (Sprite[S].BodyAnimation.ID<>Stand.ID) or
    (Sprite[S].LegsAnimation.ID<>Stand.ID) then Exit(SIM_UNSUPPORTED);
  if (Idle=4) and (Sprite[S].Weapon.Num in [BOW_NUM,BOW2_NUM]) then Exit(SIM_UNSUPPORTED);
  Sprite[S].IdleRandom:=Idle;
  Sprite[S].IdleTime:=1;
  Result:=SIM_OK;
end;
function sim_command(Tick: LongWord; Data: Pointer; Length: LongWord): LongInt;
var Obj: TJSONObject; Kind, Key: string; S, Team, Spawn, Flag,W,Secondary,Ammo,Grenades: Int64;
  Position, Velocity: TVector2; P: TPlayer; J, Created: Integer; Health,Vest: Single; D: TJSONData;
  IsBot,ForceTeam:Boolean;Profile,NameValue:string;
begin
  if not Initialized or not MapLoaded then Exit(SIM_NOT_INITIALIZED);
  SimInvalidateState;
  if Tick <> LongWord(MainTickCounter) then Exit(SIM_INVALID);
  if not ReadObject(Data,Length,Obj) then Exit(SIM_MALFORMED);
  try
    D := Obj.Find('kind'); if (D = nil) or (D.JSONType <> jtString) then Exit(SIM_MALFORMED);
    Kind := D.AsString;
    if (Kind='thing') or (Kind='bullet') or (Kind='fixture-sprite') or (Kind='weapon-choice') or (Kind='weapon-apply') then Exit(CombatCommand(Obj,Kind));
    if (Kind='gesture') or (Kind='kill') then Exit(PlayerActionCommand(Obj,Kind));
    if (Kind <> 'join') and (Kind <> 'leave') and (Kind <> 'team') and
      (Kind <> 'spawn') and (Kind <> 'appearance') then Exit(SIM_UNSUPPORTED);
    for J := 0 to Obj.Count-1 do
    begin
      Key := Obj.Names[J];
      if (Key <> 'kind') and (Key <> 'slot') and (Key <> 'team') and (Key <> 'spawn') and
         (Key <> 'x') and (Key <> 'y') and (Key <> 'health') and (Key <> 'heldFlag') and
         (Key <> 'weapon') and (Key <> 'secondaryWeapon') and (Key <> 'ammo') and
         (Key <> 'grenades') and (Key <> 'vest') and (Key <> 'control') and
         (Key <> 'bot') and (Key <> 'name') and (Key <> 'appearance') and (Key <> 'replacement') and
         (Key <> 'force') then Exit(SIM_UNSUPPORTED);
    end;
    if (Obj.Find('slot') = nil) or not JsonInteger(Obj,'slot',0,S) or (S < 1) or (S > MAX_PLAYERS) then Exit(SIM_INVALID);
    D:=Obj.Find('replacement');
    if D<>nil then
      if (Kind<>'leave') or (D.JSONType<>jtBoolean) then Exit(SIM_INVALID);
    ForceTeam:=False;D:=Obj.Find('force');
    if D<>nil then begin
      if (Kind<>'team') or (D.JSONType<>jtBoolean) then Exit(SIM_INVALID);
      ForceTeam:=D.AsBoolean;
    end;
    if not JsonInteger(Obj,'team',0,Team) or (Team < 0) or (Team > TEAM_SPECTATOR) then Exit(SIM_INVALID);
    if not AppearanceCommand(Obj,S,False) then Exit(SIM_INVALID);
    if Kind='appearance' then begin
      if not Sprite[S].Active or (Obj.Find('appearance')=nil) then Exit(SIM_INVALID);
      AppearanceCommand(Obj,S,True);SimResetRender;Exit(SIM_OK);
    end;
    if ((Kind='join') or (Kind='team')) and not TeamSupported(Team) then Exit(SIM_INVALID);
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
    // Optional human display name (presentation identity; default keeps the oracle-compatible 'oracle-<slot>').
    NameValue:='';
    D:=Obj.Find('name');
    if D<>nil then begin
      if (Kind<>'join') or IsBot or (D.JSONType<>jtString) then Exit(SIM_INVALID);
      NameValue:=D.AsString;
      if (System.Length(NameValue)<1) or (System.Length(NameValue)>PLAYERNAME_CHARS) then Exit(SIM_INVALID);
      for J:=1 to System.Length(NameValue) do
        if (Ord(NameValue[J])<32) or (Ord(NameValue[J])>126) then Exit(SIM_INVALID);
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
      Sprite[S].Kill;
      for J:=1 to MAX_PLAYERS do begin SimVisibility[S,J]:=0;SimVisibility[J,S]:=0;end;
      if not Obj.Get('replacement',False) then BalancePlayingTeams;
      SimResetRender;Exit(SIM_OK);
    end;
    if Kind = 'team' then
    begin
      if not Sprite[S].Active or (Obj.Find('team') = nil) then Exit(SIM_INVALID);
      if Sprite[S].Player.Team=Team then Exit(SIM_OK);
      if not ForceTeam and not BalancedTeamChange(S,Team) then Exit(SIM_UNSUPPORTED);
      ChangePlayingTeam(S,Team);
      if not ForceTeam then BalancePlayingTeams;
      SimResetRender;Exit(SIM_OK);
    end;
    if (Kind = 'join') and Sprite[S].Active then Exit(SIM_INVALID);
    if (Kind = 'spawn') and not Sprite[S].Active then Exit(SIM_INVALID);
    if (Kind='spawn') and SimBotOwned[S] then begin
      Sprite[S].Respawn;
      SimResetRender;Exit(SIM_OK);
    end;
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
      if sv_balanceteams.Value and (PlayingTeams>0) and (Team<>TEAM_SPECTATOR) then
        Team:=LowestPlayingTeam(Team);
      P := TPlayer.Create; P.Team := Team; P.ControlMethod := HUMAN;
      if NameValue<>'' then P.Name := NameValue else P.Name := 'oracle-' + IntToStr(S);
      if Obj.Get('control','human')='authoritative' then begin
        P.ControlMethod:=BOT;
      end;
      SimCustomShirt[S]:=P.ShirtColor;
      P.ApplyShirtColorFromTeam;
      if IsBot then RandomizeStart(Position,Team);
    end
    else P := Sprite[S].Player;
    Created := CreateSprite(Position,Velocity,1,S,P,True);
    if Created <> S then Exit(SIM_CAPACITY);
    AppearanceCommand(Obj,S,True);
    SimLimboAvailable[S]:=True;
    if Kind='join' then begin
      SimBotOwned[S]:=IsBot;
      for J:=1 to MAX_PLAYERS do begin SimVisibility[S,J]:=0;SimVisibility[J,S]:=0;end;
    end;
    if IsBot then begin
      if not LoadBotConfig(Profile,Sprite[S]) then begin Sprite[S].Kill;Exit(SIM_MALFORMED);end;
      Sprite[S].Respawn;
      Sprite[S].Player.ChatWarnings:=0;Sprite[S].Player.GrabsPerSecond:=0;
      if (Kind='join') and (MainTickCounter>0) and sv_survivalmode.Value and
        (Team<>TEAM_SPECTATOR) then begin
        Position:=Default(TVector2);
        Sprite[S].HealthHit(150,S,1,-1,Position);Dec(Sprite[S].Player.Deaths);
      end;
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
      Sprite[S].Brain.Camper:=0;
      if Kind='spawn' then SimApplyLoadout(S);
    end;
    if Obj.Find('weapon')<>nil then Sprite[S].ApplyWeaponByNum(W,1,Ammo);
    if Obj.Find('secondaryWeapon')<>nil then Sprite[S].ApplyWeaponByNum(Secondary,2);
    if P.ControlMethod=BOT then begin
      if (WeaponNumToIndex(Sprite[S].Weapon.Num)<=MAIN_WEAPONS) and
        not SimWeaponAvailable(S,WeaponNumToIndex(Sprite[S].Weapon.Num)) then
        Sprite[S].ApplyWeaponByNum(NOWEAPON_NUM,1);
      if not SimWeaponAvailable(S,WeaponNumToIndex(Sprite[S].SecondaryWeapon.Num)) then
        Sprite[S].ApplyWeaponByNum(NOWEAPON_NUM,2);
    end;
    if Grenades>=0 then Sprite[S].TertiaryWeapon.AmmoCount:=Grenades;
    Sprite[S].Vest:=Vest;
    if Flag <> 0 then
    begin
      Created := CreateThing(Position,S,Flag,255);
      if Created < 1 then Exit(SIM_CAPACITY);
      Thing[Created].HoldingSprite := S; Sprite[S].HoldedThing := Created;
    end;
    if (Kind='join') and (MainTickCounter>0) and sv_survivalmode.Value and
      (P.ControlMethod=BOT) and (Team<>TEAM_SPECTATOR) then begin
      Position:=Default(TVector2);
      Sprite[S].HealthHit(150,S,1,-1,Position);Dec(Sprite[S].Player.Deaths);
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
    { Original ServerLoop.UpdateFrame bonus cadence and draw order. }
    if not sv_survivalmode.Value and not sv_realisticmode.Value then
      if sv_bonus_frequency.Value>0 then begin
        case sv_bonus_frequency.Value of
          1:BonusFreq:=7400;2:BonusFreq:=4300;3:BonusFreq:=2500;
          4:BonusFreq:=1600;5:BonusFreq:=800;
        end;
        if sv_bonus_berserker.Value then
          if MainTickCounter mod BonusFreq=0 then
            if Random(BERSERKERBONUS_RANDOM)=0 then SpawnThings(OBJECT_BERSERK_KIT,1);
        J:=FLAMERBONUS_RANDOM;
        if sv_bonus_flamer.Value then
          if MainTickCounter mod 444=0 then
            if Random(J)=0 then SpawnThings(OBJECT_FLAMER_KIT,1);
        if sv_bonus_predator.Value then
          if MainTickCounter mod BonusFreq=0 then
            if Random(PREDATORBONUS_RANDOM)=0 then SpawnThings(OBJECT_PREDATOR_KIT,1);
        if sv_bonus_vest.Value then
          if MainTickCounter mod (BonusFreq div 2)=0 then
            if Random(VESTBONUS_RANDOM)=0 then SpawnThings(OBJECT_VEST_KIT,1);
        J:=CLUSTERBONUS_RANDOM;
        if sv_gamemode.Value in [GAMESTYLE_CTF,GAMESTYLE_INF,GAMESTYLE_HTF] then
          J:=Round(CLUSTERBONUS_RANDOM*0.75);
        if sv_bonus_cluster.Value then
          if MainTickCounter mod (BonusFreq div 2)=0 then
            if Random(J)=0 then SpawnThings(OBJECT_CLUSTER_KIT,1);
      end;
  end;
  { Original frame remainder; map loading itself is an explicit host boundary. }
  if BulletTimeTimer > -1 then Dec(BulletTimeTimer);
  if BulletTimeTimer = 0 then begin ToggleBulletTime(False); BulletTimeTimer := -1; end
  else if BulletTimeTimer < 1 then
  begin
    if (MapChangeCounter>0) and (MapChangeCounter<99999999) then begin
      Dec(MapChangeCounter);
      if MapChangeCounter=0 then SimRoundReady:=True;
    end;
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
    if (SimTimeLimitTicks>0) and (TimeLimitCounter<=1) and (MapChangeCounter<0) then NextMap;
    TimeLeftMin := TimeLimitCounter div MINUTE;
    TimeLeftSec := (TimeLimitCounter-TimeLeftMin*MINUTE) div 60;
    TimerVote;
    if not sv_advancemode.Value then
      for J := 1 to MAX_SPRITES do for I := 1 to 10 do WeaponSel[J,I] := 1;
  end;
  J:=sv_inf_bluelimit.Value*SECOND;
  if PlayersTeamNum[1]<PlayersTeamNum[2] then
    J:=sv_inf_bluelimit.Value*SECOND+2*SECOND*(PlayersTeamNum[2]-PlayersTeamNum[1]);
  if sv_gamemode.Value=GAMESTYLE_INF then
    if MapChangeCounter<0 then
      if (TeamFlag[2]>0) and Thing[TeamFlag[2]].InBase then
        if (PlayersTeamNum[1]>0) and (PlayersTeamNum[2]>0) then
          if MainTickCounter mod J=0 then begin
            Inc(TeamScore[2]);SortPlayers;
          end;
  if PlayersTeamNum[2] = PlayersTeamNum[1] then HTFTime := sv_htf_pointstime.Value*60;
  if sv_gamemode.Value=GAMESTYLE_HTF then
    if MapChangeCounter<0 then
      if (PlayersTeamNum[1]>0) and (PlayersTeamNum[2]>0) then
        if MainTickCounter mod HTFTime=0 then
          for I:=1 to MAX_SPRITES do
            if Sprite[I].Active and (Sprite[I].HoldedThing>0) then
              if Thing[Sprite[I].HoldedThing].Style=OBJECT_POINTMATCH_FLAG then begin
                Inc(TeamScore[Sprite[I].Player.Team]);
                if Sprite[I].Player.Team=TEAM_ALPHA then
                  HTFTime:=HTF_SEC_POINT+2*SECOND*(PlayersTeamNum[1]-PlayersTeamNum[2]);
                if Sprite[I].Player.Team=TEAM_BRAVO then
                  HTFTime:=HTF_SEC_POINT+2*SECOND*(PlayersTeamNum[2]-PlayersTeamNum[1]);
                if HTFTime<HTF_SEC_POINT then HTFTime:=HTF_SEC_POINT;
                SortPlayers;
              end;
  if sv_gamemode.Value=GAMESTYLE_RAMBO then
    if MainTickCounter mod SECOND=0 then begin
      _x:=0;
      for J:=1 to MAX_THINGS do
        if Thing[J].Active and (Thing[J].Style=OBJECT_RAMBO_BOW) then _x:=1;
      for J:=1 to MAX_PLAYERS do
        if Sprite[J].Active and (Sprite[J].Weapon.Num in [BOW_NUM,BOW2_NUM]) then _x:=1;
      if _x=0 then begin
        M:=Default(TVector2);RandomizeStart(M,15);
        CreateThing(M,255,OBJECT_RAMBO_BOW,255);
      end;
    end;
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
  if sv_gamemode.Value in [GAMESTYLE_POINTMATCH,GAMESTYLE_HTF] then
    if MainTickCounter mod (SECOND*2)=0 then begin
      _x:=0;
      for J:=1 to MAX_THINGS do
        if Thing[J].Active and (Thing[J].Style=OBJECT_POINTMATCH_FLAG) then Inc(_x);
      if _x>1 then
        for J:=MAX_THINGS downto 1 do
          if Thing[J].Active and (Thing[J].Style=OBJECT_POINTMATCH_FLAG) then begin
            Thing[J].Kill;Break;
          end;
      if _x=0 then
        if RandomizeStart(M,14) then
          TeamFlag[1]:=CreateThing(M,255,OBJECT_POINTMATCH_FLAG,255);
    end;
end;
function sim_step(Flags: LongWord): LongInt;
var J,K: Integer; WasDead:TSimInputHistory;Seen,NeedObserver:Boolean; FollowTeams:LongWord;
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
        SimApplyLoadout(J);
        SimLimboAvailable[J]:=True;
      end;
      { Input-owned observers always need masks. A dead human may also follow
        a teammate bot; compute those bot rows only while needed. Unused rows
        still decay so an old reveal cannot survive an unobserved interval. }
      if sv_realisticmode.Value then begin
        FollowTeams:=0;
        for J:=1 to MAX_PLAYERS do
          if Sprite[J].Active and not SimBotOwned[J] and Sprite[J].DeadMeat and
             (Sprite[J].Player.Team<=4) then
            FollowTeams:=FollowTeams or (LongWord(1) shl Sprite[J].Player.Team);
        for J:=1 to MAX_PLAYERS do if Sprite[J].Active then begin
          NeedObserver:=not SimBotOwned[J] or
            ((FollowTeams and (LongWord(1) shl Sprite[J].Player.Team))<>0);
          for K:=1 to MAX_PLAYERS do begin
            if SimVisibility[J,K]>0 then Dec(SimVisibility[J,K]);
            if NeedObserver and Sprite[K].Active then begin
              Seen:=(J=K) or Sprite[J].DeadMeat or
                ((IsTeamGame and Sprite[K].IsInSameTeam(Sprite[J])) or
                 (not IsTeamGame and Sprite[K].IsNotInSameTeam(Sprite[J])));
              if Seen or CheckSpriteLineOfSightVisibility(Sprite[J],Sprite[K]) then
                SimVisibility[J,K]:=45;
            end;
          end;
        end;
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
