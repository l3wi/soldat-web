{$ifdef CPUWASM32}
library RandomConformance;
{$else}
program RandomConformance;
{$endif}
{$mode delphi}

uses RandomConformanceCore;

{$ifdef CPUWASM32}
{ FPC wasm exports require wrappers in this library, rather than exports of
  functions declared only in a used unit. Both targets run the same test body. }
function rng_run: LongInt; cdecl;
begin
  Result := RunRandomConformance;
end;

function rng_report_ptr: PAnsiChar; cdecl;
begin
  Result := RandomConformanceReport;
end;

function rng_report_len: LongWord; cdecl;
begin
  Result := RandomConformanceReportLength;
end;

exports rng_run, rng_report_ptr, rng_report_len;
begin
end.
{$else}
var
  Status: LongInt;
begin
  Status := RunRandomConformance;
  WriteLn(RandomConformanceReport);
  Halt(Status);
end.
{$endif}
