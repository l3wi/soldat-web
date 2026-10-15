{ Derived from OpenSoldat NetworkServerGame.
  Copyright (c) 2020-2023 OpenSoldat contributors. MIT license. }
unit NetworkServerGame;
interface
uses Constants, Net;
procedure ServerMapChange(ID: Byte);
procedure ServerFlagInfo(Style, Who: Byte);
procedure ServerIdleAnimation(Num: Byte; Style: SmallInt);
procedure ServerSendVoteOn(VoteStyle: Byte; Voter: Integer;
  TargetName: string; Reason: string);
procedure ServerSendVoteOff;

implementation
uses Classes, SysUtils, Math, Vector, Calc, Game, Sprites, Bullets, Things, Weapons, PolyMap, Util, Server, NetworkUtils;
procedure ServerMapChange(ID: Byte);
var
  MapChangeMsg: TMsg_MapChange;
  i: Integer;
  DstPlayer: TPlayer;
begin
  MapChangeMsg := Default(TMsg_MapChange);
  MapChangeMsg.Header.ID := MsgID_MapChange;
  MapChangeMsg.Counter := MapChangeCounter;
  MapChangeMsg.MapName := MapChange.Name;
  MapCheckSum := GetMapChecksum(MapChange);
  MapChangeMsg.MapChecksum := MapCheckSum;

  for i := 1 to MAX_PLAYERS do
    if Sprite[i].Active then
    begin
      Sprite[i].Player.TKWarnings := 0;
      TKList[i] := '';
      TKListKills[i] := 0;
    end;

  if ID = 0 then
  begin
    // NOTE we send to pending players too, otherwise there is a small window where they miss the map change
    // NOTE also that we're using the CONNECTION channel, which is required for all packets that can be sent
    // before a sprite is assigned to the player for proper sequencing with encryption commands.
    for DstPlayer in Players do
      UDP.SendData(MapChangeMsg, sizeof(MapChangeMsg), DstPlayer.peer, k_nSteamNetworkingSend_Reliable);
    end else
      if (Sprite[ID].Active) and (Sprite[ID].Player.ControlMethod = HUMAN) then
        UDP.SendData(MapChangeMsg, sizeof(MapChangeMsg), Sprite[ID].Player.Peer, k_nSteamNetworkingSend_Reliable);
end;

procedure ServerFlagInfo(Style, Who: Byte);
var
  FlagMsg: TMsg_ServerFlagInfo;
  i: Integer;
begin
  FlagMsg := Default(TMsg_ServerFlagInfo);
  FlagMsg.Header.ID := MsgID_FlagInfo;
  FlagMsg.Style := Style;
  FlagMsg.Who := Who;

  for i := 1 to MAX_PLAYERS do
    if (Sprite[i].Active) and (Sprite[i].Player.ControlMethod = HUMAN) then
      UDP.SendData(FlagMsg, sizeof(FlagMsg), Sprite[i].Player.peer, k_nSteamNetworkingSend_Reliable);
end;

procedure ServerIdleAnimation(Num: Byte; Style: SmallInt);
var
  IdleMsg: TMsg_IdleAnimation;
  i: Integer;
begin
  IdleMsg := Default(TMsg_IdleAnimation);
  IdleMsg.Header.ID := MsgID_IdleAnimation;
  IdleMsg.Num := Num;
  IdleMsg.IdleRandom := Style;

  for i := 1 to MAX_PLAYERS do
    if (Sprite[i].Active) and (Sprite[i].Player.ControlMethod = HUMAN) then
      UDP.SendData(IdleMsg, sizeof(IdleMsg), Sprite[i].Player.peer, k_nSteamNetworkingSend_Reliable);
end;

procedure ServerSendVoteOn(VoteStyle: Byte; Voter: Integer;
  TargetName: string; Reason: string);
var
  VoteMsg: TMsg_VoteOn;
  i: Integer;
begin
  VoteMsg := Default(TMsg_VoteOn);
  VoteMsg.Header.ID := MsgID_VoteOn;
  VoteMsg.VoteType := VoteStyle;
  VoteMsg.Timer := VoteTimeRemaining;
  VoteMsg.Who := Voter;
  StringToArray(VoteMsg.TargetName, TargetName);
  StringToArray(VoteMsg.Reason, Reason);

  for i := 1 to MAX_PLAYERS do
    if (Sprite[i].Active) and (Sprite[i].Player.ControlMethod = HUMAN) then
      UDP.SendData(VoteMsg, sizeof(VoteMsg), Sprite[i].Player.peer, k_nSteamNetworkingSend_Reliable);
end;

procedure ServerSendVoteOff;
var
  VoteMsg: TMsg_VoteOff;
  i: Integer;
begin
  VoteMsg := Default(TMsg_VoteOff);
  VoteMsg.Header.ID := MsgID_VoteOff;

  for i := 1 to MAX_PLAYERS do
    if (Sprite[i].Active) and (Sprite[i].Player.ControlMethod = HUMAN) then
      UDP.SendData(VoteMsg, sizeof(VoteMsg), Sprite[i].Player.peer, k_nSteamNetworkingSend_Reliable);
end;

end.
