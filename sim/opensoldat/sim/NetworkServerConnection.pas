{ Derived from OpenSoldat NetworkServerConnection.
  Copyright (c) 2020-2023 OpenSoldat contributors. MIT license. }
unit NetworkServerConnection;
interface
uses Net;
procedure ServerSendNewPlayerInfo(Num, JoinType: Byte);
procedure ServerPlayerDisconnect(Player: TPlayer; Why: Byte; Now: Boolean = False);
implementation
uses SysUtils, Constants, Game, Server, ServerHelper, Sprites, Weapons, NetworkUtils, Util, LogFile, Demo, SimEvents;
procedure ServerSendNewPlayerInfo(Num, JoinType: Byte);
var
  NewPlayer: TMsg_NewPlayer;
  {$IFDEF SERVER}
  DstPlayer: TPlayer;
  {$ENDIF}
begin
  NewPlayer := Default(TMsg_NewPlayer);
  NewPlayer.Header.ID := MsgID_NewPlayer;
  NewPlayer.Num := Num;
  NewPlayer.JoinType := JoinType;

  StringToArray(NewPlayer.Name, Sprite[Num].Player.Name);
  NewPlayer.ShirtColor := Sprite[Num].Player.ShirtColor and $00FFFFFF;
  NewPlayer.PantsColor := Sprite[Num].Player.PantsColor and $00FFFFFF;
  NewPlayer.SkinColor := Sprite[Num].Player.SkinColor and $00FFFFFF;
  NewPlayer.HairColor := Sprite[Num].Player.HairColor and $00FFFFFF;
  NewPlayer.JetColor := Sprite[Num].Player.JetColor;
  NewPlayer.Team := Sprite[Num].Player.Team;
  NewPlayer.Pos := SpriteParts.Pos[Num];
  NewPlayer.SteamID := {$IFDEF STEAM}UInt64(Sprite[Num].Player.SteamID){$ELSE}0{$ENDIF};

  if NewPlayer.Team = TEAM_SPECTATOR then
    NewPlayer.ShirtColor := ColorToHex($FFFFFF);

  NewPlayer.Look := 0;
  if Sprite[Num].Player.HairStyle = 1 then
    NewPlayer.Look := NewPlayer.Look or B1;
  if Sprite[Num].Player.HairStyle = 2 then
    NewPlayer.Look := NewPlayer.Look or B2;
  if Sprite[Num].Player.HairStyle = 3 then
    NewPlayer.Look := NewPlayer.Look or B3;
  if Sprite[Num].Player.HairStyle = 4 then
    NewPlayer.Look := NewPlayer.Look or B4;
  if Sprite[Num].Player.HeadCap = GFX_GOSTEK_HELM then
    NewPlayer.Look := NewPlayer.Look or B5;
  if Sprite[Num].Player.HeadCap = GFX_GOSTEK_KAP then
    NewPlayer.Look := NewPlayer.Look or B6;
  if Sprite[Num].Player.Chain = 1 then
    NewPlayer.Look := NewPlayer.Look or B7;
  if Sprite[Num].Player.Chain = 2 then
    NewPlayer.Look := NewPlayer.Look or B8;

  {$IFDEF SERVER}
  // NOTE we also send to pending players to avoid desynchronization of the players list
  if not Sprite[Num].Player.DemoPlayer then
  begin
    for DstPlayer in Players do
    begin
      NewPlayer.AdoptSpriteID := Byte(Num = DstPlayer.SpriteNum);
      UDP.SendData(NewPlayer, sizeof(NewPlayer), DstPlayer.Peer, k_nSteamNetworkingSend_Reliable);
    end;
  end else
  begin
    if DemoRecorder.Active then
    begin
      NewPlayer.AdoptSpriteID := Byte(Sprite[Num].Player.DemoPlayer = True);
      DemoRecorder.SaveRecord(NewPlayer, sizeof(NewPlayer));
    end;
  end;

  AddLineToLogFile(GameLog, ' Net - ' + Sprite[Num].Player.Name + ' connected', ConsoleLogFileName);
  {$ELSE}
  NewPlayer.AdoptSpriteID := 1;
  DemoRecorder.SaveRecord(NewPlayer, sizeof(NewPlayer));
  {$ENDIF}
end;
procedure ServerPlayerDisconnect(Player: TPlayer; Why: Byte; Now: Boolean = False);
var
  PlayerDisconnectMsg: TMsg_PlayerDisconnect;
  j: Integer;
  Num: Integer;
  OwnedBySprite: Boolean;
  {$IFDEF SCRIPT}
  Kicked: Boolean;
  {$ENDIF}
begin
  PlayerDisconnectMsg := Default(TMsg_PlayerDisconnect);
  Num := Player.SpriteNum;
  OwnedBySprite := (Num <> 0) and Sprite[Num].IsPlayerObjectOwner;
  if Num <> 0 then
  begin
    for j := 0 to Sprite[Num].BulletCheckAmount do
      Sprite[Num].BulletCheck[j] := 0;

    Sprite[Num].BulletCheckIndex := 0;
    Sprite[Num].BulletCheckAmount := 0;

    Inc(MessagesASecNum[Num]);

    if (VoteActive) and (VoteType = VOTE_KICK) then
      if StrToInt(VoteTarget) = Num then
      begin
        KickPlayer(Num, True, KICK_VOTED, FIVE_MINUTES,
          'Vote Kicked (Left game)');
        StopVote;
        Exit;
      end;

    if Why <> KICK_SILENT then
    begin
      case Player.Team of
        TEAM_NONE: MainConsole.Console(
            Player.Name + ' has left the game.',
            ENTER_MESSAGE_COLOR);
        TEAM_ALPHA: MainConsole.Console(
            Player.Name + ' has left alpha team.',
            ALPHAJ_MESSAGE_COLOR);
        TEAM_BRAVO: MainConsole.Console(
            Player.Name + ' has left bravo team.',
            BRAVOJ_MESSAGE_COLOR);
        TEAM_CHARLIE: MainConsole.Console(
            Player.Name + ' has left charlie team.',
            CHARLIEJ_MESSAGE_COLOR);
        TEAM_DELTA: MainConsole.Console(
            Player.Name + ' has left delta team.',
            DELTAJ_MESSAGE_COLOR);
        TEAM_SPECTATOR: MainConsole.Console(
            Player.Name + ' has left spectators', DELTAJ_MESSAGE_COLOR);
      end;
    end;

    PlayerDisconnectMsg.Header.ID := MsgID_PlayerDisconnect;
    PlayerDisconnectMsg.Num := Num;
    PlayerDisconnectMsg.Why := Why;

    SimEventEmit(MsgID_PlayerDisconnect, Num, 0, @PlayerDisconnectMsg, SizeOf(PlayerDisconnectMsg));

    {$IFDEF SCRIPT}
    Kicked := Why in [KICK_AC, KICK_CHEAT, KICK_CONSOLE, KICK_PING, KICK_NORESPONSE,
        KICK_NOCHEATRESPONSE, KICK_FLOODING, KICK_VOTED, KICK_SILENT];
    ScrptDispatcher.OnLeaveGame(Num, Kicked);
    {$ENDIF}

    if Sprite[Num].IsNotSpectator() and (Why <> KICK_AC) and (Why <> KICK_CHEAT) and (Why <> KICK_CONSOLE) and (Why <> KICK_VOTED) then
      Sprite[Num].DropWeapon();

    for j := 1 to MAX_PLAYERS do
      if (Trim(TKList[j]) = '') or (TKList[j] = Player.IP) then
      begin
        TKListKills[j] := Player.TKWarnings;
        TKList[j] := Player.IP;
        Break;
      end;

    DoBalanceBots(1, Player.Team);

    AddLineToLogFile(GameLog, ' Net - ' + Player.Name + ' disconnected', ConsoleLogFileName);

    if Players <> nil then Players.Extract(Player);
    Sprite[Num].Kill;
  end;
  if (Num = 0) and (Players <> nil) then Players.Extract(Player);

  // Sprite.Kill frees sprite-owned players; otherwise the former network registry
  // owned the player, and the simulation now performs that lifetime cleanup.
  if not OwnedBySprite and (Player <> DummyPlayer) then Player.Free;
end;
end.
