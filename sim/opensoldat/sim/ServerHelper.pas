{ Derived from OpenSoldat ServerHelper.
  Copyright (c) 2020-2023 OpenSoldat contributors. MIT license. }
unit ServerHelper;
interface
function IDToName(ID: Integer): string;
function TeamToName(ID: Integer): string;
function NameToID(Name: string): Integer;
function NameToHW(Name: string): string;
function FindLowestTeam(const Arr: array of Integer): Integer;
function RGB(R, G, B: Byte): Cardinal;
function FixTeam(Team: Byte): Byte;
function WeaponNameByNum(Num: Integer): string;
function CheckFileSize(Filename: string): Integer;
procedure WriteConsole(ID: Byte; Text: string; Colour: UInt32);
procedure UpdateWaveRespawnTime;
procedure DoBalanceBots(LeftGame: Byte; NewTeam: Byte);
implementation
uses SysUtils, Constants, Cvar, Server, Game, Net, Sprites, Weapons, NetworkServerMessages, Util, TraceLog, PhysFS, SimRandom;
function CheckFileSize(Filename: string): Integer;
var Handle: PHYSFS_File;
begin
  Handle := PHYSFS_openRead(PChar(Filename));
  if Handle = nil then Exit(-1);
  try Result := PHYSFS_fileLength(Handle); finally PHYSFS_close(Handle); end;
end;
function IDtoName(ID: Integer): String;
begin
  Result := '';
  if ID > MAX_PLAYERS then
  begin
    Result := 'Server Admin';
    Exit;
  end;
  if (Sprite[ID].Active) then
    Result := Sprite[ID].Player.Name;
end;

function TeamToName(ID: Integer): String;
begin
  Result := 'UNKNOWN';
  if ID > 5 then
    Exit;

  case ID of
    0: Result := 'NA';
    1: Result := 'A';
    2: Result := 'B';
    3: Result := 'C';
    4: Result := 'D';
    5: Result := 'Spectator';
  end;
end;

function NameToID(Name: String): Integer;
var
  i: Integer;
begin
  Result := 0;
  for i := 1 to MAX_SPRITES do
    if Sprite[i].Active then
      if Sprite[i].Player.Name = Name then
        Result := i;
end;

function NameToHW(Name: String): String;
var
  i: Integer;
begin
  Result := '0';
  for i := 1 to MAX_SPRITES do
    if Sprite[i].Active then
      if Sprite[i].Player.Name = Name then
        Result := Sprite[i].Player.hwid;
end;

function RGB(r, g, b: Byte): Cardinal;
begin
  Result := (r or (g shl 8) or (b shl 16));
end;

function FindLowestTeam(const Arr: array of Integer): Integer;
var i, tmp: Integer;
begin
  tmp := 1;
  for i := 1 to iif(sv_gamemode.Value = GAMESTYLE_TEAMMATCH, 4, 2) do
  begin
    if Arr[tmp] > arr[i] then
      tmp := i;
  end;
  Result := tmp;
end;

function FixTeam(Team: Byte): Byte;
begin
  Result := Team;

  case sv_gamemode.Value of
    GAMESTYLE_DEATHMATCH, GAMESTYLE_POINTMATCH, GAMESTYLE_RAMBO:
    begin
      // Choose to team 0 or leave at team spectator
      if (Team <> TEAM_NONE) and
         (Team <> TEAM_SPECTATOR) then
        Result := TEAM_NONE;
    end;
    GAMESTYLE_TEAMMATCH:
    begin
      if (Team <> TEAM_ALPHA) and
         (Team <> TEAM_BRAVO) and
         (Team <> TEAM_CHARLIE) and
         (Team <> TEAM_DELTA) and
         (Team <> TEAM_SPECTATOR) then
        Result := Random(4) + 1;  // team 1..4
    end;
    GAMESTYLE_CTF, GAMESTYLE_INF, GAMESTYLE_HTF:
    begin
      if (Team <> TEAM_ALPHA) and
         (Team <> TEAM_BRAVO) and
         (Team <> TEAM_SPECTATOR) then
        Result :=  Random(2) + 1;  // team 1..2
    end;
  end;
end;

function WeaponNameByNum(Num: Integer): string;
var
  WeaponIndex: Integer;
begin
  Trace('WeaponNameByNum');
  Result := 'USSOCOM';

  if Num = 100 then
  begin
    Result := 'Selfkill';
    Exit;
  end;

  for WeaponIndex := Low(Guns) to High(Guns) do
  begin
    if Num = Guns[WeaponIndex].Num then
    begin
      Result := Guns[WeaponIndex].Name;
      Break;
    end;
  end;
end;
procedure WriteConsole(ID: Byte; Text: string; Colour: UInt32);
begin
  // Write text to the console of ALL Players
  ServerSendSpecialMessage(Text, 0, 0, 0, 0, Colour, 0, 0, ID);
end;

procedure UpdateWaveRespawnTime;
begin
  WaveRespawnTime := Round(PlayersNum * WAVERESPAWN_TIME_MULITPLIER) * 60;
  if WaveRespawnTime > sv_respawntime_minwave.Value then
    WaveRespawnTime := sv_respawntime_maxwave.Value;
  WaveRespawnTime := WaveRespawnTime - sv_respawntime_minwave.Value;
  if WaveRespawnTime < 1 then
    WaveRespawnTime := 1;
end;
procedure DoBalanceBots(LeftGame: Byte; NewTeam: Byte);
begin
  if sv_botbalance.Value and (sv_gamemode.Value in [GAMESTYLE_CTF, GAMESTYLE_HTF, GAMESTYLE_INF]) then
    raise ENotSupportedException.Create('AI is disabled in this simulation');
end;
end.
