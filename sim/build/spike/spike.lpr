library spike;
{$mode delphi}
uses SpikeCore;
{ This FPC backend only exports routines declared in the library itself.
  Discovered/documented by humanova/soldat-web, src/web/WebExports.inc (MIT);
  attribution is retained in ../NOTICE. }
procedure spike_reset; cdecl;
begin SpikeCore.spike_reset; end;
function spike_step: QWord; cdecl;
begin Result := SpikeCore.spike_step; end;
function spike_run(Ticks: LongWord): QWord; cdecl;
begin Result := SpikeCore.spike_run(Ticks); end;
function spike_state_ptr: Pointer; cdecl;
begin Result := SpikeCore.spike_state_ptr; end;
function spike_state_len: LongWord; cdecl;
begin Result := SpikeCore.spike_state_len; end;
exports spike_reset, spike_step, spike_run, spike_state_ptr, spike_state_len;
begin
end.
