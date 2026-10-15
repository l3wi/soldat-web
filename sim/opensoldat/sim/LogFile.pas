unit LogFile;
interface
uses Classes;
procedure NewLogFile(var F: TStringList; Name: string);
procedure WriteLogFile(var F: TStringList; Name: string);
procedure AddLineToLogFile(var F: TStringList; S: string; Name: string; WithDate: Boolean = True);
procedure NewLogFiles;
var
  GameLog, KillLog: TStringList;
  ConsoleLogFileName, KillLogFileName: string;
implementation
uses Server, SimEvents;
procedure NewLogFile(var F: TStringList; Name: string);
begin
  if F = nil then F := TStringList.Create else F.Clear;
end;
procedure AddLineToLogFile(var F: TStringList; S: string; Name: string; WithDate: Boolean);
begin
  if (log_enable = nil) or not log_enable.Value then Exit;
  if (log_level = nil) or (log_level.Value = 0) or (S = '') then Exit;
  // Tick-stamped queue replaces wall-clock timestamps and disk flushes.
  SimEventText(SIM_EVENT_LOG, 0, 0, S);
end;
procedure WriteLogFile(var F: TStringList; Name: string);
var I: Integer;
begin
  if (log_enable = nil) or not log_enable.Value or (F = nil) then Exit;
  for I := 0 to F.Count - 1 do SimEventText(SIM_EVENT_LOG, 0, 0, F[I]);
  F.Clear;
end;
procedure NewLogFiles;
begin
  NewLogFile(GameLog, ConsoleLogFileName);
  NewLogFile(KillLog, KillLogFileName);
end;
initialization
  GameLog := TStringList.Create;
  KillLog := TStringList.Create;
finalization
  GameLog.Free;
  KillLog.Free;
end.
