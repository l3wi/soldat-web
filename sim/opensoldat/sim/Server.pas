{*************************************************************}
{                                                             }
{       Server Unit for OpenSoldat                            }
{                                                             } 
{       Copyright (c) 2002      Michal Marcinkowski           }
{       Copyright (c) 2020-2023 OpenSoldat contributors       }
{                                                             }
{*************************************************************}

unit Server;
interface
uses Classes, SysUtils, Cvar, Constants, Net, Console, Sprites;
function LoadMapsList(Filename: string = ''): Boolean;
procedure LoadWeapons(Filename: string);
procedure NextMap;
procedure SpawnThings(Style, Amount: Byte);
function KickPlayer(Num: Byte; Ban: Boolean; Why, Time: Integer; Reason: string = ''): Boolean;
function PrepareMapChange(Name: string): Boolean;
var
  ProgReady: Boolean = False;
  BaseDirectory: string;
  UserDirectory: string;
  MainThreadID: TThreadID;

  // Cvars
  log_enable: TBooleanCvar;
  log_level: TIntegerCvar;
  log_filesupdate: TIntegerCvar;
  log_timestamp: TBooleanCvar;

  fs_mod: TStringCvar;
  fs_portable: TBooleanCvar;
  fs_basepath: TStringCvar;
  fs_userpath: TStringCvar;

  demo_autorecord: TBooleanCvar;

  sv_respawntime:         TIntegerCvar;
  sv_respawntime_minwave: TIntegerCvar;
  sv_respawntime_maxwave: TIntegerCvar;

  sv_dm_limit: TIntegerCvar;
  sv_pm_limit: TIntegerCvar;
  sv_tm_limit: TIntegerCvar;
  sv_rm_limit: TIntegerCvar;

  sv_inf_redaward:  TIntegerCvar;
  sv_inf_limit:     TIntegerCvar;
  sv_inf_bluelimit: TIntegerCvar;

  sv_htf_limit:      TIntegerCvar;
  sv_htf_pointstime: TIntegerCvar;

  sv_ctf_limit: TIntegerCvar;

  sv_bonus_frequency: TIntegerCvar;
  sv_bonus_flamer: TBooleanCvar;
  sv_bonus_predator: TBooleanCvar;
  sv_bonus_berserker: TBooleanCvar;
  sv_bonus_vest: TBooleanCvar;
  sv_bonus_cluster: TBooleanCvar;

  sv_stationaryguns: TBooleanCvar;

  sv_password: TStringCvar;
  sv_adminpassword: TStringCvar;
  sv_maxplayers: TIntegerCvar;
  sv_maxspectators: TIntegerCvar;
  sv_spectatorchat: TBooleanCvar;
  sv_greeting: TStringCvar;
  sv_greeting2: TStringCvar;
  sv_greeting3: TStringCvar;
  sv_info: TStringCvar;
  sv_minping: TIntegerCvar;
  sv_maxping: TIntegerCvar;
  sv_votepercent: TIntegerCvar;
  sv_lockedmode: TBooleanCvar;
  sv_pidfilename: TStringCvar;
  sv_maplist: TStringCvar;
  sv_lobby: TBooleanCvar;
  sv_lobbyurl: TStringCvar;

  sv_steamonly: TBooleanCvar;

  {$IFDEF STEAM}
  sv_voicechat: TBooleanCvar;
  sv_voicechat_alltalk: TBooleanCvar;
  sv_setsteamaccount: TStringCvar;
  {$ENDIF}

  sv_warnings_flood: TIntegerCvar;
  sv_warnings_ping: TIntegerCvar;
  sv_warnings_votecheat: TIntegerCvar;
  sv_warnings_knifecheat: TIntegerCvar;
  sv_warnings_tk: TIntegerCvar;

  sv_anticheatkick: TBooleanCvar;
  sv_punishtk: TBooleanCvar;
  sv_botbalance: TBooleanCvar;
  sv_echokills: TBooleanCvar;
  sv_antimassflag: TBooleanCvar;
  sv_healthcooldown: TIntegerCvar;
  sv_teamcolors: TBooleanCvar;
  sv_pauseonidle: TBooleanCvar;

  net_port: TIntegerCvar;
  net_ip: TStringCvar;
  net_adminip: TStringCvar;
  net_lan: TIntegerCvar;
  net_allowdownload: TBooleanCvar;
  net_maxadminconnections: TIntegerCvar;
  net_rcon_limit: TIntegerCvar;
  net_rcon_burst: TIntegerCvar;

  net_floodingpacketslan: TIntegerCvar;
  net_floodingpacketsinternet: TIntegerCvar;

  net_t1_snapshot: TIntegerCvar;
  net_t1_majorsnapshot: TIntegerCvar;
  net_t1_deadsnapshot: TIntegerCvar;
  net_t1_heartbeat: TIntegerCvar;
  net_t1_delta: TIntegerCvar;
  net_t1_ping: TIntegerCvar;
  net_t1_thingsnapshot: TIntegerCvar;

  bots_random_noteam: TIntegerCvar;
  bots_random_alpha: TIntegerCvar;
  bots_random_bravo: TIntegerCvar;
  bots_random_charlie: TIntegerCvar;
  bots_random_delta: TIntegerCvar;
  bots_difficulty: TIntegerCvar;
  bots_chat: TBooleanCvar;

  sc_enable: TBooleanCvar;
  sc_onscriptcrash: TStringCvar;
  sc_safemode: TBooleanCvar;
  sc_allowdlls: TBooleanCvar;
  sc_sandboxed: TIntegerCvar;
  sc_defines: TStringCvar;
  sc_searchpaths: TStringCvar;

  fileserver_enable: TBooleanCvar;
  fileserver_port: TIntegerCvar;
  fileserver_ip: TStringCvar;
  fileserver_maxconnections: TIntegerCvar;

  launcher_ipc_enable: TBooleanCvar;
  launcher_ipc_port: TIntegerCvar;
  launcher_ipc_reconnect_rate: TIntegerCvar;

  // syncable cvars
  sv_gamemode: TIntegerCvar;
  sv_friendlyfire: TBooleanCvar;
  sv_timelimit: TIntegerCvar;
  sv_maxgrenades: TIntegerCvar;
  sv_bullettime: TBooleanCvar;
  sv_sniperline: TBooleanCvar;
  sv_balanceteams: TBooleanCvar;
  sv_survivalmode: TBooleanCvar;
  sv_survivalmode_antispy: TBooleanCvar;
  sv_survivalmode_clearweapons: TBooleanCvar;
  sv_realisticmode: TBooleanCvar;
  sv_advancemode: TBooleanCvar;
  sv_advancemode_amount: TIntegerCvar;
  sv_guns_collide: TBooleanCvar;
  sv_kits_collide: TBooleanCvar;
  sv_minimap_locations: TBooleanCvar;
  sv_advancedspectator: TBooleanCvar;
  sv_radio: TBooleanCvar;
  sv_gravity: TSingleCvar;
  sv_hostname: TStringCvar;
  sv_killlimit: TIntegerCvar;
  sv_downloadurl: TStringCvar;
  sv_pure: TBooleanCvar;
  sv_website: TStringCvar;

  {$IFDEF ENABLE_FAE}
  ac_enable: TBooleanCvar;
  {$ENDIF}

  // config stuff
  ServerIP: string = '127.0.0.1';
  ServerPort: Integer = 23073;
  BonusFreq: Integer = 3600;
  WeaponActive: array[-1..15] of Byte;

  MapsList: TStrings;

  LastPlayer: Byte;

  OldBulletSnapshotMsg: array[1..MAX_SPRITES] of TMsg_BulletSnapshot;

  // Mute array
  MuteList: array[1..MAX_PLAYERS] of ShortString;
  MuteName: array[1..MAX_PLAYERS] of string;

  // TK array
  TKList:      array[1..MAX_PLAYERS] of ShortString;  // IP
  TKListKills: array[1..MAX_PLAYERS] of Byte;         // TK Warnings

  TCPBytesSent: Int64;
  TCPBytesReceived: Int64;

  // Consoles
  MainConsole: TConsole;

  RemoteIPs, AdminIPs: TStrings;

  FloodIP:  array[1..MAX_FLOODIPS] of ShortString;
  FloodNum: array[1..MAX_FLOODIPS] of Integer;

  LastReqIP: array[0..3] of ShortString;  // last 4 IP's to request game
  LastReqID: Byte = 0;
  DropIP: ShortString = '';

  WaveRespawnTime, WaveRespawnCounter: Integer;

  WeaponsInGame: Integer;

  BulletWarningCount: array[1..MAX_SPRITES] of Byte;

  CheatTag: array[1..MAX_SPRITES] of Byte;

  {$IFDEF RCON}
  AdminServer: TAdminServer;
  {$ENDIF}
  // bullet shot stats
  ShotDistance: Single;
  ShotLife: Single;
  ShotRicochet: Integer;

  HTFTime: Integer = HTF_SEC_POINT;

  WMName, WMVersion: string;
  LastWepMod: string;

  ModDir: string = '';
  UDP: TServerNetwork;

implementation
uses Game, Things, SharedConfig, Weapons, TraceLog, SimEvents, ServerHelper, NetworkServerConnection, NetworkServerGame, NetworkUtils, Vector, Util, PhysFS, SimRandom;
procedure LoadWeapons(Filename: string);
var
  IsRealistic: Boolean;
  i: Integer;
begin
  Debug('LoadWeapons');

  IsRealistic := sv_realisticmode.Value = True;
  CreateWeapons(IsRealistic);
  // FIXME (falcon) while the above instruction has to be done every time,
  // because you never know if WM provides all the values,
  // this could be done only once per mode (realistic/non-realistic)
  DefaultWMChecksum := CreateWMChecksum();

  if not LoadWeaponsConfig(UserDirectory +  'configs/' + Filename + '.ini') then
  begin
    SimEventText(SIM_EVENT_LOG, 0, 0, 'Using default weapons mod');
    CreateWeapons(IsRealistic);
  end;

  LoadedWMChecksum := CreateWMChecksum();

  if LoadedWMChecksum <> DefaultWMChecksum then
  begin
    MainConsole.Console('Loaded weapons mod "' + WMName + ' v' + WMVersion + '"',
      SERVER_MESSAGE_COLOR);
  end;

  for i := 1 to MAX_PLAYERS do
    if Sprite[i].Active then
      Sprite[i].ApplyWeaponByNum(Sprite[i].Weapon.Num, 1, Sprite[i].Weapon.AmmoCount);
end;
function PrepareMapChange(Name: String): Boolean;
var
  Status: TMapInfo;
begin
  Result := False;
  if GetMapInfo(Name, UserDirectory, Status) then
  begin
    MapChange := Status;
    // Make sure time limit doesn't change map out from under us.
    TimeLimitCounter := 0;
    MapChangeCounter := MapChangeTime;
    // send to client that map changes
    ServerMapChange(ALL_PLAYERS);
    MainConsole.Console('Next map: ' + Status.Name, GAME_MESSAGE_COLOR);
    {$IFDEF SCRIPT}
    ScrptDispatcher.OnBeforeMapChange(Status.Name);
    {$ENDIF}
    Result := True;
  end;
end;

procedure NextMap;
begin
  { The simulation owns scoring and the original results countdown. Map
    selection and the explicit loadMap epoch boundary belong to the host. }
  if MapChangeCounter<0 then PrepareMapChange(Map.Name);
end;


procedure SpawnThings(Style, Amount: Byte);
var
  i, k, l, team: Integer;
  a: TVector2;
begin
  Trace('SpawnThings');

  a := Default(TVector2);
  k := 0;
  case Style of
    OBJECT_MEDICAL_KIT:  k := 8;
    OBJECT_GRENADE_KIT:  k := 7;
    OBJECT_FLAMER_KIT:   k := 11;
    OBJECT_PREDATOR_KIT: k := 13;
    OBJECT_VEST_KIT:     k := 10;
    OBJECT_BERSERK_KIT:  k := 12;
    OBJECT_CLUSTER_KIT:  k := 9;
  end;

  for i := 1 to Amount do
  begin
    team := 0;
    if sv_gamemode.Value = GAMESTYLE_CTF then
      if (Style = OBJECT_MEDICAL_KIT) or (Style = OBJECT_GRENADE_KIT) then
      begin
        if i mod 2 = 0 then
          team := 1
        else
          team := 2;
      end;

    Thing[MAX_THINGS - 1].Team := team;

    if team = 0 then
    begin
      if not RandomizeStart(a, k) then Exit
    end else
      if not SpawnBoxes(a, k, MAX_THINGS - 1) then
        if not RandomizeStart(a, k) then Exit;

    a.X := a.X - SPAWNRANDOMVELOCITY +
      (Random(Round(2 * 100 * SPAWNRANDOMVELOCITY)) / 100);
    a.Y := a.Y - SPAWNRANDOMVELOCITY +
      (Random(Round(2 * 100 * SPAWNRANDOMVELOCITY)) / 100);
    l := CreateThing(a, 255, Style, 255);

    if (l > 0) and (l < MAX_THINGS + 1) then
      Thing[l].Team := team;
  end;
end;

function LoadMapsList(Filename: string): Boolean;
var Stream: TStream;
begin
  if Filename = '' then Filename := sv_maplist.Value;
  Stream := PHYSFS_readAsStream(PChar(UserDirectory + 'configs/' + Filename));
  Result := Stream <> nil;
  if not Result then Exit;
  try MapsList.LoadFromStream(Stream); finally Stream.Free; end;
end;

function KickPlayer(Num: Byte; Ban: Boolean; Why, Time: Integer; Reason: string): Boolean;
begin
  Result := False;
  if (Num < 1) or (Num > MAX_PLAYERS) then Exit;
  if not Sprite[Num].Active then Exit;
  if (Why = KICK_CHEAT) and not sv_anticheatkick.Value then Exit;
  if (Why in [KICK_PING, KICK_FLOODING, KICK_VOTED]) and
     (Length(Sprite[Num].Player.IP) > 5) and
     (IsRemoteAdminIP(Sprite[Num].Player.IP) or IsAdminIP(Sprite[Num].Player.IP)) then Exit;
  // Admission/ban persistence belongs to the host; never pretend to write OS ban lists.
  if Ban then
  begin
    SimEventInts($100, Num, 0, [Why, Time]);
    SimEventText($101, Num, 0, Reason);
  end;
  ServerPlayerDisconnect(Sprite[Num].Player, Why);
  Result := True;
end;

initialization
  MapsList := TStringList.Create;
  RemoteIPs := TStringList.Create;
  AdminIPs := TStringList.Create;
  MainConsole.CountMax := 7;
finalization
  MapsList.Free;
  RemoteIPs.Free;
  AdminIPs.Free;
end.
