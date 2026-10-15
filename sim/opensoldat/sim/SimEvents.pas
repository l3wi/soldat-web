unit SimEvents;

interface

uses SysUtils;

const
  SIM_EVENT_CAPACITY = 1048576;
  SIM_EVENT_PRESENTATION = $80000000;
  SIM_EVENT_CONSOLE = SIM_EVENT_PRESENTATION or 1;
  SIM_EVENT_LOG = SIM_EVENT_PRESENTATION or 2;
  SIM_EVENT_IDLE = SIM_EVENT_PRESENTATION or 3;
  SIM_EVENT_DEATH = $1001;
  SIM_EVENT_FLAG_INFO = $1002;
  SIM_EVENT_THING_TAKEN = $1003;
  SIM_EVENT_THING_STATE = $1004;
  SIM_EVENT_RESPAWN = $1005;
  SIM_EVENT_TEAM_SCORES = $1006;
  SIM_EVENT_MATCH_END = $1007;

type
  ESimEventOverflow = class(Exception);
  TSimEventHeader = packed record
    Kind, Tick, Source, Target, PayloadBytes: LongWord;
  end;

procedure SimEventsReset;
procedure SimEventsSetReplay(Replay: Boolean);
procedure SimEventsSetTick(Tick: LongWord);
procedure SimEventEmit(Kind, Source, Target: LongWord; Data: Pointer; Size: LongWord);
procedure SimEventInts(Kind, Source, Target: LongWord; const Values: array of LongInt);
procedure SimEventText(Kind, Source, Target: LongWord; const Text: AnsiString);
function SimEventsRead(OutBuffer: Pointer; Capacity: LongWord): LongInt;

var
  SimEventsOverflow: Boolean = False;

implementation

var
  Buffer: array[0..SIM_EVENT_CAPACITY - 1] of Byte;
  Used, CurrentTick: LongWord;
  Replaying: Boolean;

procedure SimEventsReset;
begin
  Used := 0;
  CurrentTick := 0;
  Replaying := False;
  SimEventsOverflow := False;
end;

procedure SimEventsSetReplay(Replay: Boolean);
begin
  Replaying := Replay;
end;

procedure SimEventsSetTick(Tick: LongWord);
begin
  CurrentTick := Tick;
end;

procedure SimEventEmit(Kind, Source, Target: LongWord; Data: Pointer; Size: LongWord);
var
  Header: TSimEventHeader;
begin
  if Replaying and ((Kind and SIM_EVENT_PRESENTATION) <> 0) then Exit;
  if (Size > SIM_EVENT_CAPACITY - SizeOf(Header)) or
     (Used > SIM_EVENT_CAPACITY - SizeOf(Header) - Size) then
  begin
    SimEventsOverflow := True;
    raise ESimEventOverflow.Create('Simulation event queue capacity exceeded');
  end;
  if (Size <> 0) and (Data = nil) then
    raise EArgumentException.Create('Missing simulation event payload');
  Header.Kind := Kind;
  Header.Tick := CurrentTick;
  Header.Source := Source;
  Header.Target := Target;
  Header.PayloadBytes := Size;
  Move(Header, Buffer[Used], SizeOf(Header));
  Inc(Used, SizeOf(Header));
  if Size <> 0 then Move(Data^, Buffer[Used], Size);
  Inc(Used, Size);
end;

procedure SimEventInts(Kind, Source, Target: LongWord; const Values: array of LongInt);
begin
  if Length(Values) = 0 then SimEventEmit(Kind, Source, Target, nil, 0)
  else SimEventEmit(Kind, Source, Target, @Values[0], Length(Values) * SizeOf(LongInt));
end;

procedure SimEventText(Kind, Source, Target: LongWord; const Text: AnsiString);
begin
  if Text = '' then SimEventEmit(Kind, Source, Target, nil, 0)
  else SimEventEmit(Kind, Source, Target, @Text[1], Length(Text));
end;

function SimEventsRead(OutBuffer: Pointer; Capacity: LongWord): LongInt;
begin
  if SimEventsOverflow then Exit(-5);
  Result := Used;
  if (OutBuffer = nil) or (Capacity < Used) then Exit;
  if Used <> 0 then Move(Buffer[0], OutBuffer^, Used);
  Used := 0;
end;

end.
