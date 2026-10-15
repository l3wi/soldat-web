{*************************************************************}
{                                                             }
{       Net Unit for OPENSOLDAT                               }
{                                                             }
{       Copyright (c) 2002-2003 Michal Marcinkowski           }
{       Copyright (c) 2020-2024 OpenSoldat contributors       }
{                                                             }
{*************************************************************}

unit Net;

interface
uses Classes, fgl, SysUtils, sha1, Vector, Constants, Weapons;
const
  k_nSteamNetworkingSend_Unreliable = 0;
  k_nSteamNetworkingSend_Reliable = 8;
  // Binary ops
  B1  =     1;
  B2  =     2;
  B3  =     4;
  B4  =     8;
  B5  =    16;
  B6  =    32;
  B7  =    64;
  B8  =   128;
  B9  =   256;
  B10 =   512;
  B11 =  1024;
  B12 =  2048;
  B13 =  4096;
  B14 =  8192;
  B15 = 16384;
  B16 = 32768;

  // MESSAGE IDs
  MsgID_Custom                     = 0;
  MsgID_HeartBeat                  = MsgID_Custom +  2;
  MsgID_ServerSpriteSnapshot       = MsgID_Custom +  3;
  MsgID_ClientSpriteSnapshot       = MsgID_Custom +  4;
  MsgID_BulletSnapshot             = MsgID_Custom +  5;
  MsgID_ChatMessage                = MsgID_Custom +  6;
  MsgID_ServerSkeletonSnapshot     = MsgID_Custom +  7;
  MsgID_MapChange                  = MsgID_Custom +  8;
  MsgID_ServerThingSnapshot        = MsgID_Custom +  9;
  MsgID_ThingTaken                 = MsgID_Custom + 12;
  MsgID_SpriteDeath                = MsgID_Custom + 13;
  MsgID_PlayerInfo                 = MsgID_Custom + 15;
  MsgID_PlayersList                = MsgID_Custom + 16;
  MsgID_NewPlayer                  = MsgID_Custom + 17;
  MsgID_ServerDisconnect           = MsgID_Custom + 18;
  MsgID_PlayerDisconnect           = MsgID_Custom + 19;
  MsgID_Delta_Movement             = MsgID_Custom + 21;
  MsgID_Delta_Weapons              = MsgID_Custom + 25;
  MsgID_Delta_Helmet               = MsgID_Custom + 26;
  MsgID_Delta_MouseAim             = MsgID_Custom + 29;
  MsgID_Ping                       = MsgID_Custom + 30;
  MsgID_Pong                       = MsgID_Custom + 31;
  MsgID_FlagInfo                   = MsgID_Custom + 32;
  MsgID_ServerThingMustSnapshot    = MsgID_Custom + 33;
  MsgID_IdleAnimation              = MsgID_Custom + 37;
  MsgID_ServerSpriteSnapshot_Major = MsgID_Custom + 41;
  MsgID_ClientSpriteSnapshot_Mov   = MsgID_Custom + 42;
  MsgID_ClientSpriteSnapshot_Dead  = MsgID_Custom + 43;
  MsgID_UnAccepted                 = MsgID_Custom + 44;
  MsgID_VoteOn                     = MsgID_Custom + 45;
  MsgID_VoteMap                    = MsgID_Custom + 46;
  MsgID_VoteMapReply               = MsgID_Custom + 47;
  MsgID_VoteKick                   = MsgID_Custom + 48;
  MsgID_RequestThing               = MsgID_Custom + 51;
  MsgID_ServerVars                 = MsgID_Custom + 52;
  MsgID_ServerSyncMsg              = MsgID_Custom + 54;
  MsgID_ClientFreeCam              = MsgID_Custom + 55;
  MsgID_VoteOff                    = MsgID_Custom + 56;
  MsgID_FaeData                    = MsgID_Custom + 57;
  MsgID_RequestGame                = MsgID_Custom + 58;
  MsgID_ForcePosition              = MsgID_Custom + 60;
  MsgID_ForceVelocity              = MsgID_Custom + 61;
  MsgID_ForceWeapon                = MsgID_Custom + 62;
  MsgID_ChangeTeam                 = MsgID_Custom + 63;
  MsgID_SpecialMessage             = MsgID_Custom + 64;
  MsgID_WeaponActiveMessage        = MsgID_Custom + 65;
  MsgID_JoinServer                 = MsgID_Custom + 68;
  MsgID_PlaySound                  = MsgID_Custom + 70;
  MsgID_SyncCvars                  = MsgID_Custom + 71;
  MsgID_VoiceData                  = MsgID_Custom + 72;

  MAX_PLAYERS = 32;

  VERSION_PACKET_CHARS = 24;

  // ControlMethod
  HUMAN = 1;
  BOT   = 2;

  // Request Reply States
  OK                 =  1;
  WRONG_VERSION      =  2;
  WRONG_PASSWORD     =  3;
  BANNED_IP          =  4;
  SERVER_FULL        =  5;
  INVALID_HANDSHAKE  =  8;
  WRONG_CHECKSUM     =  9;
  ANTICHEAT_REQUIRED = 10;
  ANTICHEAT_REJECTED = 11;
  STEAM_ONLY         = 12;

  LAN      = 1;
  INTERNET = 0;

  // FLAG INFO
  RETURNRED   = 1;
  RETURNBLUE  = 2;
  CAPTURERED  = 3;
  CAPTUREBLUE = 4;

  // Kick/Ban Why's
  KICK_UNKNOWN         =  0;
  KICK_NORESPONSE      =  1;
  KICK_NOCHEATRESPONSE =  2; // TODO remove?
  KICK_CHANGETEAM      =  3; // TODO remove?
  KICK_PING            =  4;
  KICK_FLOODING        =  5;
  KICK_CONSOLE         =  6;
  KICK_CONNECTCHEAT    =  7; // TODO remove?
  KICK_CHEAT           =  8;
  KICK_LEFTGAME        =  9;
  KICK_VOTED           = 10;
  KICK_AC              = 11;
  KICK_SILENT          = 12;
  KICK_STEAMTICKET     = 13;
  _KICK_END            = 14;

  // Join types
  JOIN_NORMAL = 0;
  JOIN_SILENT = 1;

  // RECORD
  NETW = 0;
  REC  = 1;

  CLIENTPLAYERRECIEVED_TIME = 3 * 60;

  FLOODIP_MAX  = 18;
  MAX_FLOODIPS = 1000;
  MAX_BANIPS   = 1000;

  PLAYERNAME_CHARS = 24;
  PLAYERHWID_CHARS = 11;
  MAPNAME_CHARS    = 64;
  REASON_CHARS     = 26;

  ACTYPE_NONE = 0;
  ACTYPE_FAE  = 1;

  MSGTYPE_CMD   = 0;
  MSGTYPE_PUB   = 1;
  MSGTYPE_TEAM  = 2;
  MSGTYPE_RADIO = 3;

type
  HSteamNetConnection = LongWord;
  TServerNetwork = object
    function SendData(var Data; Size: Integer; Peer: HSteamNetConnection; Flags: Integer): Boolean;
  end;
  TPlayer = class
  public
    // (!!!) When extending this class also extend its clone method, else ScriptCore breaks (maybe).

    // client/server shared stuff:
    // TODO stuff here that is relevant for the sprite (color, team, ...) should be moved to
    // a template object instead. When a sprite is created, then copy the template to it and apply
    // modifications depending on the game mode (eg. change the shirt color to match the team.)
    // That would allow switching game modes etc. without losing information about the player.
    Name: string;
    ShirtColor, PantsColor, SkinColor, HairColor, JetColor: LongWord;
    Kills, Deaths: Integer;
    Flags: Byte;
    PingTicks, PingTicksB, PingTime, Ping: Integer;
    RealPing: Word;
    ConnectionQuality: Byte;
    Team: Byte;
    ControlMethod: Byte;
    Chain, HeadCap, HairStyle: Byte;
    SecWep: Byte;
    Camera: Byte;
    Muted: Byte;
    SpriteNum: Byte; // 0 if no sprite exists yet
    DemoPlayer: Boolean;
    {$IFDEF STEAM}
    SteamID: CSteamID;
    SteamStats: Boolean;
    LastReceiveVoiceTime: Integer;
    SteamFriend: Boolean;
    {$ENDIF}

    // server only below this line:
    // -----
    {$IFDEF SERVER}
    IP: string;
    Port: Integer;

    // anti-cheat client handles and state
    {$IFDEF ENABLE_FAE}
    FaeResponsePending: Boolean;
    FaeKicked: Boolean;
    FaeTicks: Integer;
    FaeSecret: TFaeSecret;
    {$ENDIF}

    Peer: HSteamNetConnection;
    HWID: string;
    PlayTime: Integer;
    GameRequested: Boolean;

    // counters for warnings:
    ChatWarnings: Byte;
    TKWarnings: Byte;

    // anti mass flag counters:
    ScoresPerSecond: Integer;
    GrabsPerSecond: Integer;
    GrabbedInBase: Boolean;  // To prevent false accusations
    StandingPolyType: Byte;  // Testing
    KnifeWarnings: Byte;

    constructor Create();
    destructor Destroy(); override;
    {$ENDIF SERVER}
    procedure ApplyShirtColorFromTeam; // TODO remove, see comment before Name
    function Clone: TPlayer;
  end;

  TPlayers = TFPGObjectList<TPlayer>;

  TStatsString = array[0..2048] of Char;
  TIPString = array[0..128] of Char;

  PmsgHeader = ^TMsgHeader;
  TMsgHeader = packed record
    ID: Byte;
  end;

  PMsg_StringMessage = ^TMsg_StringMessage;
  TMsg_StringMessage = packed record
    Header: TMsgHeader;
    Num: Byte;
    MsgType: Byte;
    Text: array[0..0] of WideChar;
  end;

  PMsg_Ping = ^TMsg_Ping;
  TMsg_Ping = packed record
    Header: TMsgHeader;
    PingTicks: Byte;
    PingNum: Byte;
  end;

  PMsg_Pong = ^TMsg_Pong;
  TMsg_Pong = packed record
    Header: TMsgHeader;
    PingNum: Byte;
  end;

  // HEARTBEAT TYPE
  // - every while information about frags, server status etc.
  PMsg_HeartBeat = ^TMsg_HeartBeat;
  TMsg_HeartBeat = packed record
    Header: TMsgHeader;
    MapID: LongWord;
    TeamScore:         array[1..4] of Word;
    Active:            array[1..MAX_PLAYERS] of Boolean;
    Kills:             array[1..MAX_PLAYERS] of Word;
    Caps:              array[1..MAX_PLAYERS] of Byte;
    Team:              array[1..MAX_PLAYERS] of Byte;
    Deaths:            array[1..MAX_PLAYERS] of Word;
    Ping:              array[1..MAX_PLAYERS] of Byte;
    RealPing:          array[1..MAX_PLAYERS] of Word;
    ConnectionQuality: array[1..MAX_PLAYERS] of Byte;
    Flags:             array[1..MAX_PLAYERS] of Byte;
  end;

  // SERVERSPRITESNAPSHOT TYPE
  // - servers object status - uses for all objects in game
  PMsg_ServerSpriteSnapshot = ^TMsg_ServerSpriteSnapshot;
  TMsg_ServerSpriteSnapshot = packed record
    Header: TMsgHeader;
    Num: Byte;
    Pos, Velocity: TVector2;
    MouseAimX, MouseAimY: SmallInt;
    Position: Byte;
    Keys16: Word;
    Look: Byte;
    Vest: Single;
    Health: Single;
    AmmoCount, GrenadeCount: Byte;
    WeaponNum, SecondaryWeaponNum: Byte;
    ServerTicks: LongInt;
  end;

  PMsg_ServerSpriteSnapshot_Major = ^TMsg_ServerSpriteSnapshot_Major;
  TMsg_ServerSpriteSnapshot_Major = packed record
    Header: TMsgHeader;
    Num: Byte;
    Pos, Velocity: TVector2;
    Health: Single;
    MouseAimX, MouseAimY: SmallInt;
    Position: Byte;
    Keys16: Word;
    ServerTicks: LongInt;
  end;

  PMsg_ServerVars = ^TMsg_ServerVars;
  TMsg_ServerVars = packed record
    Header: TMsgHeader;
    Damage:            array[1..ORIGINAL_WEAPONS] of Single;
    Ammo:              array[1..ORIGINAL_WEAPONS] of Byte;
    ReloadTime:        array[1..ORIGINAL_WEAPONS] of Word;
    Speed:             array[1..ORIGINAL_WEAPONS] of Single;
    BulletStyle:       array[1..ORIGINAL_WEAPONS] of Byte;
    StartUpTime:       array[1..ORIGINAL_WEAPONS] of Word;
    Bink:              array[1..ORIGINAL_WEAPONS] of SmallInt;
    FireInterval:      array[1..ORIGINAL_WEAPONS] of Word;
    MovementAcc:       array[1..ORIGINAL_WEAPONS] of Single;
    BulletSpread:      array[1..ORIGINAL_WEAPONS] of Single;
    Recoil:            array[1..ORIGINAL_WEAPONS] of Word;
    Push:              array[1..ORIGINAL_WEAPONS] of Single;
    InheritedVelocity: array[1..ORIGINAL_WEAPONS] of Single;
    ModifierHead:      array[1..ORIGINAL_WEAPONS] of Single;
    ModifierChest:     array[1..ORIGINAL_WEAPONS] of Single;
    ModifierLegs:      array[1..ORIGINAL_WEAPONS] of Single;
    NoCollision:       array[1..ORIGINAL_WEAPONS] of Byte;
    WeaponActive:      array[1..MAIN_WEAPONS] of Byte;
  end;

  PMsg_ServerSyncCvars = ^TMsg_ServerSyncCvars;
  TMsg_ServerSyncCvars = packed record
    Header: TMsgHeader;
    ItemCount: Byte;
    Data: array[0..0] of Byte;
  end;

  // CLIENTSPRITESNAPSHOT TYPE
  // - current players status
  PMsg_ClientSpriteSnapshot = ^TMsg_ClientSpriteSnapshot;
  TMsg_ClientSpriteSnapshot = packed record
    Header: TMsgHeader;
    AmmoCount, SecondaryAmmoCount: Byte;
    WeaponNum, SecondaryWeaponNum: Byte;
    Position: Byte;
  end;

  PMsg_ClientSpriteSnapshot_Mov = ^TMsg_ClientSpriteSnapshot_Mov;
  TMsg_ClientSpriteSnapshot_Mov = packed record
    Header: TMsgHeader;
    Pos, Velocity: TVector2;
    Keys16: Word;
    MouseAimX, MouseAimY: SmallInt;
  end;

  PMsg_ClientSpriteSnapshot_Dead = ^TMsg_ClientSpriteSnapshot_Dead;
  TMsg_ClientSpriteSnapshot_Dead = packed record
    Header: TMsgHeader;
    CameraFocus: Byte;
  end;

  // BULLETSNAPSHOT TYPE
  // - for server's bullet information
  PMsg_BulletSnapshot = ^TMsg_BulletSnapshot;
  TMsg_BulletSnapshot = packed record
    Header: TMsgHeader;
    Owner, WeaponNum: Byte;
    Pos, Velocity: TVector2;
    Seed: Word;
    Forced: Boolean; // CreateBullet() forced bullet?
  end;

  // BULLETSNAPSHOT TYPE
  // - for clients' bullet information
  PMsg_ClientBulletSnapshot = ^TMsg_ClientBulletSnapshot;
  TMsg_ClientBulletSnapshot = packed record
    Header: TMsgHeader;
    WeaponNum: Byte;
    Pos, Velocity: TVector2;
    Seed: Word;
    ClientTicks: LongInt;
  end;

  // SERVERSKELETONSNAPSHOT TYPE
  // - info on the sprites skeleton - used when sprite is DeadMeat
  PMsg_ServerSkeletonSnapshot = ^TMsg_ServerSkeletonSnapshot;
  TMsg_ServerSkeletonSnapshot = packed record
    Header: TMsgHeader;
    Num: Byte;
    // Constraints: byte;
    RespawnCounter: SmallInt;
  end;

  // MAPCHANGE TYPE
  PMsg_MapChange = ^TMsg_MapChange;
  TMsg_MapChange = packed record
    Header: TMsgHeader;
    Counter: SmallInt;
    MapName: string[MAPNAME_CHARS];
    MapChecksum: TSHA1Digest;
  end;

  // SERVERTHINGSNAPSHOT TYPE
  // - info on the things in world that move
  PMsg_ServerThingSnapshot = ^TMsg_ServerThingSnapshot;
  TMsg_ServerThingSnapshot = packed record
    Header: TMsgHeader;
    Num, Owner, Style, HoldingSprite: Byte;
    Pos, OldPos: array[1..4] of TVector2;
  end;

  // SERVERTHINGMUSTSNAPSHOT TYPE
  // - info on the things in world
  PMsg_ServerThingMustSnapshot = ^TMsg_ServerThingMustSnapshot;
  TMsg_ServerThingMustSnapshot = packed record
    Header: TMsgHeader;
    Num, Owner, Style, HoldingSprite: Byte;
    Pos, OldPos: array[1..4] of TVector2;
    Timeout: LongInt;
  end;

  // SERVERTHINGTAKENINFO TYPE
  // - sent when thing is taken
  PMsg_ServerThingTaken = ^TMsg_ServerThingTaken;
  TMsg_ServerThingTaken = packed record
    Header: TMsgHeader;
    Num, Who: Byte;
    Style, AmmoCount: Byte;
  end;

  // SPRITEDEATH TYPE
  // - if sprite dies this is sent
  PMsg_SpriteDeath = ^TMsg_SpriteDeath;
  TMsg_SpriteDeath = packed record
    Header: TMsgHeader;
    Num, Killer, KillBullet, Where: Byte;
    Constraints: Byte;
    Pos, OldPos: array[1..16] of TVector2;
    Health: Single;
    OnFire: Byte;
    RespawnCounter: SmallInt;
    ShotDistance, ShotLife: Single;
    ShotRicochet: Byte;
  end;

  // REQUEST GAME TYPE
  PMsg_RequestGame = ^TMsg_RequestGame;
  TMsg_RequestGame = packed record
    Header: TMsgHeader;
    Version: array[0..VERSION_PACKET_CHARS - 1] of Char;
    Forwarded: Byte;
    HaveAntiCheat: Byte;
    HardwareID: string[PLAYERHWID_CHARS];
    Password: array[0..24] of Char;
  end;

  // PLAYER INFO TYPE
  PMsg_PlayerInfo = ^TMsg_PlayerInfo;
  TMsg_PlayerInfo = packed record
    Header: TMsgHeader;
    Name: array[0..PLAYERNAME_CHARS - 1] of Char;
    Look: Byte;
    Team: Byte;
    ShirtColor, PantsColor, SkinColor, HairColor, JetColor: LongWord;
    GameModChecksum: TSHA1Digest;
    CustomModChecksum: TSHA1Digest;
  end;

  // PLAYERS LIST TYPE
  PMsg_PlayersList = ^TMsg_PlayersList;
  TMsg_PlayersList = packed record
    Header: TMsgHeader;
    ModName: array[0..MAPNAME_CHARS - 1] of Char;
    ModChecksum: TSHA1Digest;
    MapName: array[0..MAPNAME_CHARS - 1] of Char;
    MapChecksum: TSHA1Digest;
    Players: Byte;
    Name:         array[1..MAX_PLAYERS] of array[0..PLAYERNAME_CHARS - 1] of Char;
    ShirtColor, PantsColor, SkinColor, HairColor, JetColor:
                  array[1..MAX_PLAYERS] of LongWord;
    Team:         array[1..MAX_PLAYERS] of Byte;
    PredDuration: array[1..MAX_PLAYERS] of Byte;
    Look:         array[1..MAX_PLAYERS] of Byte;
    Pos:          array[1..MAX_PLAYERS] of TVector2;
    Vel:          array[1..MAX_PLAYERS] of TVector2;
    SteamID:      array[1..MAX_PLAYERS] of UInt64;
    CurrentTime: Integer;
    ServerTicks: LongInt;
    AntiCheatRequired: Boolean;
  end;

  // REJECTED CONNECTION TYPE
  PMsg_UnAccepted = ^TMsg_UnAccepted;
  TMsg_UnAccepted = packed record
    Header: TMsgHeader;
    State: Byte;
    Version: array[0..VERSION_PACKET_CHARS - 1] of Char;
    Text: array[0..0] of Char;
  end;

  // NEW PLAYER TYPE
  PMsg_NewPlayer = ^TMsg_NewPlayer;
  TMsg_NewPlayer = packed record
    Header: TMsgHeader;
    Num: Byte;
    AdoptSpriteID: Byte;
    JoinType: Byte;
    Name: array[0..PLAYERNAME_CHARS - 1] of Char;
    ShirtColor, PantsColor, SkinColor, HairColor, JetColor: LongWord;
    Team: Byte;
    Look: Byte;
    Pos: TVector2;
    SteamID: UInt64;
  end;

  // SERVER DISCONNECT TYPE
  PMsg_ServerDisconnect = ^TMsg_ServerDisconnect;
  TMsg_ServerDisconnect = packed record
    Header: TMsgHeader;
  end;

  // PLAYER DISCONNECT TYPE
  PMsg_PlayerDisconnect = ^TMsg_PlayerDisconnect;
  TMsg_PlayerDisconnect = packed record
    Header: TMsgHeader;
    Num: Byte;
    Why: Byte;
  end;

  // IDLE ANIMATION TYPE
  PMsg_IdleAnimation = ^TMsg_IdleAnimation;
  TMsg_IdleAnimation = packed record
    Header: TMsgHeader;
    Num: Byte;
    IdleRandom: SmallInt;
  end;

  PMsg_ClientFreeCam = ^TMsg_ClientFreeCam;
  TMsg_ClientFreeCam = packed record
    Header: TMsgHeader;
    FreeCamOn: Byte;
    TargetPos: TVector2;
  end;

  // DELTAS
  PMsg_ServerSpriteDelta_Movement = ^TMsg_ServerSpriteDelta_Movement;
  TMsg_ServerSpriteDelta_Movement = packed record
    Header: TMsgHeader;
    Num: Byte;
    Pos, Velocity: TVector2;
    Keys16: Word;
    MouseAimX, MouseAimY: SmallInt;
    ServerTick: LongInt;
  end;

  PMsg_ServerSpriteDelta_MouseAim = ^TMsg_ServerSpriteDelta_MouseAim;
  TMsg_ServerSpriteDelta_MouseAim = packed record
    Header: TMsgHeader;
    Num: Byte;
    MouseAimX, MouseAimY: SmallInt;
  end;

  PMsg_ServerSpriteDelta_Weapons = ^TMsg_ServerSpriteDelta_Weapons;
  TMsg_ServerSpriteDelta_Weapons = packed record
    Header: TMsgHeader;
    Num: Byte;
    WeaponNum, SecondaryWeaponNum: Byte;
    AmmoCount: Byte;
  end;

  PMsg_ServerSpriteDelta_Helmet = ^TMsg_ServerSpriteDelta_Helmet;
  TMsg_ServerSpriteDelta_Helmet = packed record
    Header: TMsgHeader;
    Num: Byte;
    WearHelmet: Byte;
  end;

  PMsg_ServerFlagInfo = ^TMsg_ServerFlagInfo;
  TMsg_ServerFlagInfo = packed record
    Header: TMsgHeader;
    Style, Who: Byte;
  end;

  PMsg_ServerSyncMsg = ^TMsg_ServerSyncMsg;
  TMsg_ServerSyncMsg = packed record
    Header: TMsgHeader;
    Time: Integer;
    Pause: Byte;
  end;

  {$IFDEF ENABLE_FAE}
  PMsg_FaeChallenge = ^TMsg_FaeChallenge;
  TMsg_FaeChallenge = packed record
    Header: TMsgHeader;
    InOrder: Byte;
    Challenge: TFaeChallenge;
  end;

  PMsg_FaeResponse = ^TMsg_FaeResponse;
  TMsg_FaeResponse = packed record
    Header: TMsgHeader;
    Response: TFaeResponseBox;
  end;
  {$ENDIF}

  PMsg_ForcePosition = ^TMsg_ForcePosition;
  TMsg_ForcePosition = packed record
    Header: TMsgHeader;
    Pos: TVector2;
    PlayerID: Byte;
  end;

  PMsg_ForceVelocity = ^TMsg_ForceVelocity;
  TMsg_ForceVelocity = packed record
    Header: TMsgHeader;
    Vel: TVector2;
    PlayerID: Byte;
  end;

  PMsg_ForceWeapon = ^TMsg_ForceWeapon;
  TMsg_ForceWeapon = packed record
    Header: TMsgHeader;
    WeaponNum, SecondaryWeaponNum: Byte;
    AmmoCount, SecAmmoCount: Byte;
  end;

  PMsg_ChangeTeam = ^TMsg_ChangeTeam;
  TMsg_ChangeTeam = packed record
    Header: TMsgHeader;
    Team: Byte;
  end;

  PMsg_RequestThing = ^TMsg_RequestThing;
  TMsg_RequestThing = packed record
    Header: TMsgHeader;
    ThingID: Byte;
  end;

  // Voting Messages

  // VOTING ON TYPE
  PMsg_VoteOn = ^TMsg_VoteOn;
  TMsg_VoteOn = packed record
    Header: TMsgHeader;
    VoteType: Byte;
    Timer: Word;
    Who: Byte;
    TargetName: array[0..MAPNAME_CHARS - 1] of Char;
    Reason: array[0..REASON_CHARS - 1] of Char;
  end;

  // VOTING OFF TYPE
  PMsg_VoteOff = ^TMsg_VoteOff;
  TMsg_VoteOff = packed record
    Header: TMsgHeader;
  end;

  // VOTING MAP LIST QUERY
  PMsg_VoteMap = ^TMsg_VoteMap;
  TMsg_VoteMap = packed record
    Header: TMsgHeader;
    MapID: Word;
  end;

  // VOTING MAP LIST RESPONSE
  PMsg_VoteMapReply = ^TMsg_VoteMapReply;
  TMsg_VoteMapReply = packed record
    Header: TMsgHeader;
    Count: Word;
    MapName: String[MAPNAME_CHARS];
  end;

  // VOTING KICK TYPE
  PMsg_VoteKick = ^TMsg_VoteKick;
  TMsg_VoteKick = packed record
    Header: TMsgHeader;
    Ban: Byte;
    Num: Byte;
    Reason: array[0..REASON_CHARS - 1] of Char;
  end;

  // MESSAGE PACKET
  PMsg_ServerSpecialMessage = ^TMsg_ServerSpecialMessage;
  TMsg_ServerSpecialMessage = packed record
    Header: TMsgHeader;
    MsgType: Byte;  // 0 - console, 1 - big text, 2 - world text
    LayerId: Byte;  // only used for big text and world text
    Delay: Integer;
    Scale: Single;
    Color: UInt32;
    X, Y: Single;
    Text: array[0..0] of Char;
  end;

  // HIDE/SHOW WEAPON IN MENU FOR SPECIFIC PLAYER
  PMsg_WeaponActiveMessage = ^TMsg_WeaponActiveMessage;

  TMsg_WeaponActiveMessage = packed record
    Header: TMsgHeader;
    Active, Weapon: Byte;
  end;

  PMsg_JoinServer = ^TMsg_JoinServer;
  TMsg_JoinServer = packed record
    Header: TMsgHeader;
    IP: LongWord;
    Port: Word;
    ShowMsg: array[0..50] of Char;
  end;

  PMsg_PlaySound = ^TMsg_PlaySound;
  TMsg_PlaySound = packed record  // Server -> Client
    Header: TMsgHeader;
    Name: array[0..26] of Char;
    Emitter: TVector2;
  end;

  PMsg_VoiceData = ^TMsg_VoiceData;
  TMsg_VoiceData = packed record
    Header: TMsgHeader;
    Speaker: Byte;
    Data: array[0..0] of Char;
  end;

var
  MainTickCounter: Integer;
  // Stores all network-generated TPlayer objects
  Players: TPlayers;

  {$IFNDEF SERVER}
  ClientTickCount, LastHeartBeatCounter: LongInt;
  ClientPlayerReceivedCounter: Integer;
  ClientPlayerReceived, ClientPlayerSent: Boolean;
  ClientVarsRecieved: Boolean;
  RequestingGame: Boolean;
  NoHeartbeatTime: Integer = 0;
  ReceivedUnAccepted: Boolean;
  VoteMapName: String;
  VoteMapCount: Word;
  {$ELSE}
  // We're assigning a dummy player class to all sprites that are currently not being controlled
  // by a player. This avoids nasty surprises with older code that reads .Player despite .Active
  // being false. A player object is swapped in by CreateSprite as needed. For bots we simply leave
  // the bot object and free it when it is replaced.
  // Albeit this approach is very robust I'd prefer if we get rid of this and fix all .Active
  // checks (if any) later. Alternatively we could move a good bit if info from Player to Sprite.
  DummyPlayer: TPlayer;

  ServerTickCounter: Integer;
  NoClientUpdateTime: array[1..MAX_PLAYERS] of Integer;
  MessagesASecNum:    array[1..MAX_PLAYERS] of Integer;
  FloodWarnings:      array[1..MAX_PLAYERS] of Byte;
  PingWarnings:       array[1..MAX_PLAYERS] of Byte;
  BulletTime:         array[1..MAX_PLAYERS] of Integer;
  GrenadeTime:        array[1..MAX_PLAYERS] of Integer;
  KnifeCan:           array[1..MAX_PLAYERS] of Boolean;
  {$ENDIF}

  PlayersNum, BotsNum, SpectatorsNum: Integer;
  PlayersTeamNum: array[1..4] of Integer;

  PingTicksAdd: Integer = {$IFDEF SERVER} 0 {$ELSE} 2 {$ENDIF};

  {$IFDEF SCRIPT}
  ForceWeaponCalled: Boolean;
  {$ENDIF}


implementation
uses Server, Game, SimEvents;
function TServerNetwork.SendData(var Data; Size: Integer; Peer: HSteamNetConnection; Flags: Integer): Boolean;
var Kind: LongWord;
begin
  if Size < SizeOf(TMsgHeader) then raise EArgumentException.Create('Invalid event packet size');
  Kind := PMsgHeader(@Data)^.ID;
  if Kind in [MsgID_ChatMessage, MsgID_IdleAnimation, MsgID_SpecialMessage, MsgID_PlaySound] then
    Kind := Kind or SIM_EVENT_PRESENTATION;
  SimEventEmit(Kind, 0, Peer, @Data, Size);
  Result := True;
end;

constructor TPlayer.Create();
begin
end;

destructor TPlayer.Destroy();
begin
end;
function TPlayer.Clone: TPlayer;
begin
  // NOTE that only fields used by TScriptNewPlayer really matter here, but we clone the whole
  // thing for consistency. Obviously don't clone handles etc. unless they can be duplicated.

  Result := TPlayer.Create;

  Result.Name := Self.Name;
  Result.ShirtColor := Self.ShirtColor;
  Result.PantsColor := Self.PantsColor;
  Result.SkinColor := Self.SkinColor;
  Result.HairColor := Self.HairColor;
  Result.JetColor := Self.JetColor;
  Result.Kills := Self.Kills;
  Result.Deaths := Self.Deaths;
  Result.Flags := Self.Flags;
  Result.PingTicks := Self.PingTicks;
  Result.PingTicksB := Self.PingTicksB;
  Result.PingTime := Self.PingTime;
  Result.RealPing := Self.RealPing;
  Result.ConnectionQuality := Self.ConnectionQuality;
  Result.Ping := Self.Ping;
  Result.Team := Self.Team;
  Result.ControlMethod := Self.ControlMethod;
  Result.Chain := Self.Chain;
  Result.HeadCap := Self.HeadCap;
  Result.HairStyle := Self.HairStyle;
  Result.SecWep := Self.SecWep;
  Result.Camera := Self.Camera;
  Result.Muted := Self.Muted;
  Result.SpriteNum := Self.SpriteNum;
  Result.DemoPlayer := Self.DemoPlayer;
  {$IFDEF STEAM}
  Result.SteamID := Self.SteamID;
  Result.SteamStats := Self.SteamStats;
  {$ENDIF}

  {$IFDEF SERVER}
  Result.IP := Self.IP;
  Result.Port := Self.Port;
  {$IFDEF ENABLE_FAE}
  Result.FaeResponsePending := Self.FaeResponsePending;
  Result.FaeKicked := Self.FaeKicked;
  Result.FaeTicks := Self.FaeTicks;
  Result.FaeSecret := Self.FaeSecret;
  {$ENDIF}
  Result.hwid := Self.hwid;
  Result.PlayTime := Self.PlayTime;
  Result.GameRequested := Self.GameRequested;
  Result.ChatWarnings := Self.ChatWarnings;
  Result.TKWarnings := Self.TKWarnings;
  Result.ScoresPerSecond := Self.ScoresPerSecond;
  Result.GrabsPerSecond := Self.GrabsPerSecond;
  Result.GrabbedInBase := Self.GrabbedInBase;
  Result.StandingPolyType := Self.StandingPolyType;
  Result.KnifeWarnings := Self.KnifeWarnings;
  {$ENDIF}
end;

procedure TPlayer.ApplyShirtColorFromTeam;
begin
  {$IFDEF SERVER}
  if sv_teamcolors.Value and IsTeamGame() then
    case Self.Team of
      1: Self.ShirtColor := $FFD20F05;
      2: Self.ShirtColor := $FF151FD9;
      3: Self.ShirtColor := $FFD2D205;
      4: Self.ShirtColor := $FF05D205;
    end;
  {$ENDIF}
end;

initialization
  Players := TPlayers.Create(False);
finalization
  Players.Free;
end.
