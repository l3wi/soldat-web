unit Console;
interface
const CONSOLE_MAX_MESSAGES = 20;
type
  TConsole = object
    TextMessage: array[1..CONSOLE_MAX_MESSAGES] of WideString;
    TextMessageColor: array[1..CONSOLE_MAX_MESSAGES] of LongWord;
    NumMessage: array[1..CONSOLE_MAX_MESSAGES] of Integer;
    Count, CountMax, ScrollTick, ScrollTickMax, NewMessageWait: Integer;
    AlphaCount: Byte;
    TerminalColors: Boolean;
    procedure ScrollConsole;
    procedure Console(What: Variant; Col: Cardinal; Sender: Byte); overload;
    procedure Console(What: WideString; Col: Cardinal); overload;
    procedure Console(What: AnsiString; Col: Cardinal); overload;
    procedure Console(What: Variant; Col: Cardinal); overload;
    procedure ConsoleAdd(What: WideString; Col: Cardinal);
    procedure ConsoleNum(What: WideString; Col: Cardinal; Num: Integer);
    function GetContentsAsPlainText: WideString;
  end;
implementation
uses SimEvents, Net, NetworkServerMessages;

procedure TConsole.ScrollConsole;
var I: Integer;
begin
  if Count > 0 then
  begin
    for I := 1 to Count - 1 do
    begin
      TextMessage[I] := TextMessage[I + 1];
      TextMessageColor[I] := TextMessageColor[I + 1];
      NumMessage[I] := NumMessage[I + 1];
      AlphaCount := 255;
    end;
    TextMessage[Count] := '';
    NumMessage[Count] := 0;
    Dec(Count);
  end;
  ScrollTick := 0;
end;

procedure TConsole.ConsoleNum(What: WideString; Col: Cardinal; Num: Integer);
begin
  if (CountMax < 1) or (CountMax > CONSOLE_MAX_MESSAGES) then CountMax := CONSOLE_MAX_MESSAGES;
  if Count >= CONSOLE_MAX_MESSAGES then ScrollConsole;
  Inc(Count);
  ScrollTick := -NewMessageWait;
  TextMessage[Count] := What;
  TextMessageColor[Count] := Col;
  NumMessage[Count] := Num;
  if Count = 1 then AlphaCount := 255;
  if Count = CountMax then ScrollConsole;
end;

procedure TConsole.ConsoleAdd(What: WideString; Col: Cardinal);
begin
  ConsoleNum(What, Col, -255);
end;

procedure TConsole.Console(What: WideString; Col: Cardinal);
begin
  if What = '' then Exit;
  SimEventText(SIM_EVENT_CONSOLE, 0, Col, UTF8Encode(What));
  if (CountMax < 1) or (CountMax > CONSOLE_MAX_MESSAGES) then CountMax := CONSOLE_MAX_MESSAGES;
  Inc(Count);
  if Count >= CountMax then Count := 1;
  ScrollTick := -NewMessageWait;
  TextMessage[Count] := What;
  TextMessageColor[Count] := Col;
  NumMessage[Count] := -255;
  if Count = 1 then AlphaCount := 255;
end;

procedure TConsole.Console(What: AnsiString; Col: Cardinal);
begin Self.Console(WideString(What), Col); end;
procedure TConsole.Console(What: Variant; Col: Cardinal);
begin Self.Console(WideString(What), Col); end;
procedure TConsole.Console(What: Variant; Col: Cardinal; Sender: Byte);
begin
  Self.Console(What, Col);
  if (Sender > 0) and (Sender < MAX_PLAYERS + 1) then
    ServerSendStringMessage(What, Sender, 255, MSGTYPE_PUB);
end;
function TConsole.GetContentsAsPlainText: WideString;
var I: Integer;
begin
  Result := '';
  for I := 1 to Count do Result := Result + TextMessage[I] + LineEnding;
end;
end.
