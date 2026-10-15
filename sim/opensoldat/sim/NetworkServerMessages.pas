{ Derived from OpenSoldat NetworkServerMessages.
  Copyright (c) 2020-2023 OpenSoldat contributors. MIT license. }
unit NetworkServerMessages;
interface
procedure ServerSendStringMessage(Text: WideString; ToNum, From, MsgType: Byte);
procedure ServerSendSpecialMessage(Text: string; MsgType, LayerId: Byte; Delay: Integer; Scale: Single; Color: UInt32; X, Y: Single; ToNum: Byte);
implementation
uses SysUtils, Net, Game, Server, Sprites, Constants, Util;
procedure ServerSendStringMessage(Text: WideString; ToNum: Byte; From: Byte; MsgType: Byte);
var
  PChatMessage: PMsg_StringMessage;
  i: Integer;
  Size: Integer;
begin
  if Length(Text) = 0 then
    Exit;
  PChatMessage := Default(PMsg_StringMessage);
  Size := SizeOf(PChatMessage^.Header) + SizeOf(PChatMessage^.Num) +
    SizeOf(PChatMessage^.MsgType) + 2 * Length(Text) + 1 + 1;
  GetMem(PChatMessage, Size);
  FillChar(PChatMessage^, Size, 0);

  PChatMessage^.Header.ID := MsgID_ChatMessage;
  PChatMessage^.Num := From;
  PChatMessage^.MsgType := MsgType;

  Move(Text[1], PChatMessage.Text, 2 * Length(Text) + 2);

  if ((From > 0) and (From < MAX_PLAYERS + 1)) or (From = 255) then
  begin
    for i := 1 to MAX_PLAYERS do
      if Sprite[i].Active and (Sprite[i].Player.ControlMethod = HUMAN) then
        if (ToNum = 0) or (i = ToNum) then
        begin
          if (not ((MsgType = MSGTYPE_TEAM) or (MsgType = MSGTYPE_RADIO)) or (From = 255)) or
            (((MsgType = MSGTYPE_TEAM) or (MsgType = MSGTYPE_RADIO)) and Sprite[From].IsInSameTeam(Sprite[i])) then
            UDP.SendData(PChatMessage^, Size, Sprite[i].Player.peer, k_nSteamNetworkingSend_Reliable)
        end;
  end;
  FreeMem(PChatMessage);

  if (From < 1) or (From > MAX_PLAYERS) then
    Exit;

  // show text on servers side
  if Sprite[From].Player.ControlMethod = BOT then
  begin
    MainConsole.Console(iif(MsgType = MSGTYPE_TEAM, '(TEAM)', '') +
      '[' + Sprite[From].Player.Name + '] ' + Text, TEAMCHAT_MESSAGE_COLOR);
  end;
end;
procedure ServerSendSpecialMessage(Text: string; MsgType: Byte;
  LayerId: Byte; Delay: Integer; Scale: Single; Color: UInt32;
  X: Single; Y: Single; ToNum: Byte);
var
  PChatMessage: PMsg_ServerSpecialMessage;
  Size: Integer;
  i: Integer;
begin
  Size := SizeOf(TMsg_ServerSpecialMessage) + Length(Text) + 1;
  GetMem(PChatMessage, Size);
  FillChar(PChatMessage^, Size, 0);

  PChatMessage^.Header.ID := MsgID_SpecialMessage;
  PChatMessage^.MsgType := MsgType;
  PChatMessage^.LayerId := LayerId;
  PChatMessage^.Delay := Delay;
  PChatMessage^.Scale := Scale;
  PChatMessage^.Color := Color;
  PChatMessage^.X := X;
  PChatMessage^.Y := Y;

  StrPCopy(@PChatMessage^.Text, PChar(Text));

  for i := 1 to MAX_PLAYERS do
    if Sprite[i].Active and (Sprite[i].Player.ControlMethod = HUMAN) then
      if (ToNum = 0) or (i = ToNum) then
        UDP.SendData(PChatMessage^, size, Sprite[i].Player.peer, k_nSteamNetworkingSend_Reliable);

  FreeMem(PChatMessage);
end;
end.
