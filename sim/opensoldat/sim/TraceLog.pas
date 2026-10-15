unit TraceLog;
interface
const LEVEL_OFF = 0; LEVEL_DEBUG = 1; LEVEL_TRACE = 2;
procedure Debug(const Msg: string);
procedure Trace(const Msg: string);
implementation
uses Server, SimEvents;
procedure Debug(const Msg: string);
begin
  if Assigned(log_level) then
    if log_level.Value >= LEVEL_DEBUG then SimEventText(SIM_EVENT_LOG, 0, LEVEL_DEBUG, Msg);
end;
procedure Trace(const Msg: string);
begin
  if Assigned(log_level) then
    if log_level.Value >= LEVEL_TRACE then SimEventText(SIM_EVENT_LOG, 0, LEVEL_TRACE, Msg);
end;
end.
