program CheckSignedLoads;
{$mode delphi}

uses SysUtils;

type
  TPackedFields = packed record
    Prefix: Byte;
    S8: ShortInt;
    S16: SmallInt;
    S32: LongInt;
  end;

const
  Values8: array[0..4] of LongInt = (-128, -1, 0, 1, 127);
  Values16: array[0..4] of LongInt = (-32768, -1, 0, 1, 32767);
  Values32: array[0..4] of LongInt = (-2147483648, -1, 0, 1, 2147483647);

procedure Fail(const Field, Comparison: string; Expected: LongInt);
begin
  WriteLn(StdErr, 'Signed packed load regression: ', Field, ' ', Comparison,
    ' is incorrect for ', Expected);
  Halt(1);
end;

procedure Check(var Data: TPackedFields; Expected8, Expected16, Expected32: LongInt);
begin
  if Data.S8 <> Expected8 then Fail('S8', 'value', Expected8);
  if (Data.S8 > 0) <> (Expected8 > 0) then Fail('S8', '> 0', Expected8);
  if (Data.S8 < 0) <> (Expected8 < 0) then Fail('S8', '< 0', Expected8);
  if (Data.S8 < 1) <> (Expected8 < 1) then Fail('S8', '< 1', Expected8);
  if Data.S16 <> Expected16 then Fail('S16', 'value', Expected16);
  if (Data.S16 > 0) <> (Expected16 > 0) then Fail('S16', '> 0', Expected16);
  if (Data.S16 < 0) <> (Expected16 < 0) then Fail('S16', '< 0', Expected16);
  if (Data.S16 < 1) <> (Expected16 < 1) then Fail('S16', '< 1', Expected16);
  if Data.S32 <> Expected32 then Fail('S32', 'value', Expected32);
  if (Data.S32 > 0) <> (Expected32 > 0) then Fail('S32', '> 0', Expected32);
  if (Data.S32 < 0) <> (Expected32 < 0) then Fail('S32', '< 0', Expected32);
  if (Data.S32 < 1) <> (Expected32 < 1) then Fail('S32', '< 1', Expected32);
end;

var
  Data: TPackedFields;
  I: Integer;
begin
  Data.Prefix := 0;
  for I := Low(Values16) to High(Values16) do
  begin
    Data.S8 := Values8[I];
    Data.S16 := Values16[I];
    Data.S32 := Values32[I];
    Check(Data, Values8[I], Values16[I], Values32[I]);
  end;
  WriteLn('{"status":"pass","check":"signed-packed-loads","widths":[8,16,32],"cases":15}');
end.
