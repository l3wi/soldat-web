program spike_native;
{$mode delphi}
uses SysUtils, SpikeCore;
var I, J, Ticks: Integer; H: QWord; Bits: LongWord;
begin
  Ticks := 10000;
  if ParamCount > 0 then Ticks := StrToInt(ParamStr(1));
  if (ParamCount > 1) and (ParamStr(2) = '--trace') then
  begin
    spike_reset;
    for I := 1 to Ticks do
    begin
      H := spike_step;
      Write(I, ' ', LowerCase(IntToHex(H, 16)));
      for J := 0 to StateFloats - 1 do
      begin
        Move(State[J], Bits, 4);
        Write(' ', LowerCase(IntToHex(Bits, 8)));
      end;
      WriteLn;
    end;
  end else
    WriteLn(LowerCase(IntToHex(spike_run(Ticks), 16)));
end.
