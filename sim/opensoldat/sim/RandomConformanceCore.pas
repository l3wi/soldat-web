unit RandomConformanceCore;

{$mode delphi}
{$Q-}{$R-}

interface

function RunRandomConformance: LongInt;
function RandomConformanceReport: PAnsiChar;
function RandomConformanceReportLength: LongWord;

implementation

uses SysUtils, SimRandom;

const
  FixedSeeds: array[0..15] of LongWord = (
    $FFFFFFFF, 0, 1, $80000000, $7FFFFFFF, $FFFFFFFE, 2, $12345678,
    $87654321, $AAAAAAAA, $55555555, $00010000, $FFFF0000,
    $01010101, $DEADBEEF, $C001D00D);
  Bounds32: array[0..23] of LongInt = (
    0, 1, -1, 2, -2, 3, -3, Low(LongInt), High(LongInt),
    Low(LongInt) + 1, High(LongInt) - 1, 65535, -65535, 65536, -65536,
    65537, -65537, 1073741825, -1073741826, 1431655765, -1431655766,
    16777217, -16777218, 2147483646);
  Bounds64: array[0..29] of Int64 = (
    0, 1, -1, 2, -2, Low(LongInt), High(LongInt),
    Int64(Low(LongInt)) - 1, Int64(High(LongInt)) + 1,
    Int64(High(LongInt)) + 2, Int64(Low(LongInt)) - 2,
    4294967295, 4294967296, 4294967297,
    -4294967295, -4294967296, -4294967297,
    Low(Int64), High(Int64), Low(Int64) + 1, High(Int64) - 1,
    4611686018427387905, -4611686018427387906,
    6148914691236517205, -6148914691236517206,
    1099511627775, 1099511627776, 1099511627777,
    -1099511627776, -1099511627777);
  MixedDrawsPerSeed = 16384;
  GeneratedSeeds = 48;

type
  EConformanceMismatch = class(Exception);

var
  ReportText: AnsiString;
  HasRun: Boolean = False;
  RunStatus: LongInt = 1;
  Calls, Count32, Count64, CountFloat: QWord;
  Assignments, SeedCases: LongWord;
  Digest: QWord;
  InputState: LongWord;
  CurrentSeed: LongWord;
  Stage: AnsiString;
  CaseIndex: LongInt;

function Hex64(Value: QWord): AnsiString;
begin
  Result := IntToHex(Value, 16);
end;

procedure Hash(Value: QWord);
var
  I: LongInt;
begin
  { Explicit little-endian byte order makes the transcript hash portable. }
  for I := 0 to 7 do
  begin
    Digest := (Digest xor (Value and $FF)) * QWord($100000001B3);
    Value := Value shr 8;
  end;
end;

function NextInput: LongWord;
begin
  { Independent test-input LCG; never advances either RNG under test. }
  InputState := InputState * LongWord(1664525) + LongWord(1013904223);
  Result := InputState;
end;

function NextInput64: Int64;
var
  HighWord, LowWord: LongWord;
begin
  HighWord := NextInput;
  LowWord := NextInput;
  Result := Int64((QWord(HighWord) shl 32) or LowWord);
end;

procedure AssignSeed(Seed: LongWord);
begin
  { Only the public seed is assigned after the one initial portable reset.
    In particular, assigning its current complement must NOT reset hidden
    System state. This deliberately preserves the pinned RTL's caveat. }
  CurrentSeed := Seed;
  System.RandSeed := Seed;
  SimRandom.RandSeed := Seed;
  Inc(Assignments);
  Hash($53454544);
  Hash(Seed);
end;

procedure Check(Kind: LongWord; A, B, Expected, Actual: QWord);
var
  ExpectedSeed, ActualSeed: LongWord;
begin
  Inc(Calls);
  ExpectedSeed := LongWord(System.RandSeed);
  ActualSeed := LongWord(SimRandom.RandSeed);
  if (Expected <> Actual) or (ExpectedSeed <> ActualSeed) then
  begin
    ReportText := '{"status":"fail","mismatches":1,"call":' + UIntToStr(Calls) +
      ',"stage":"' + Stage + '","case":' + IntToStr(CaseIndex) +
      ',"assignedSeed":"' + IntToHex(CurrentSeed, 8) +
      '","kind":' + UIntToStr(Kind) + ',"a":"' + Hex64(A) +
      '","b":"' + Hex64(B) + '","expected":"' + Hex64(Expected) +
      '","actual":"' + Hex64(Actual) + '","expectedRandSeed":"' +
      IntToHex(ExpectedSeed, 8) + '","actualRandSeed":"' +
      IntToHex(ActualSeed, 8) + '"}';
    raise EConformanceMismatch.Create('RNG conformance mismatch');
  end;
  Hash(Kind);
  Hash(A);
  Hash(B);
  Hash(Expected);
  Hash(ExpectedSeed);
end;

procedure Draw32(Bound: LongInt);
var
  Expected, Actual: LongInt;
begin
  Expected := System.Random(Bound);
  Actual := SimRandom.Random(Bound);
  Inc(Count32);
  Check(1, QWord(Int64(Bound)), 0, QWord(Int64(Expected)), QWord(Int64(Actual)));
end;

procedure Draw64(Bound: Int64);
var
  Expected, Actual: Int64;
begin
  Expected := System.Random(Bound);
  Actual := SimRandom.Random(Bound);
  Inc(Count64);
  Check(2, QWord(Bound), 0, QWord(Expected), QWord(Actual));
end;

procedure DrawFloat;
var
  Expected, Actual: Double;
  ExpectedBits, ActualBits: QWord;
begin
  Expected := System.Random;
  Actual := SimRandom.Random;
  Move(Expected, ExpectedBits, SizeOf(ExpectedBits));
  Move(Actual, ActualBits, SizeOf(ActualBits));
  Inc(CountFloat);
  Check(3, 0, 0, ExpectedBits, ActualBits);
end;

procedure BoundaryCases;
var
  I, J: LongInt;
  Power32: LongWord;
  Power64: QWord;
begin
  Stage := 'boundaries';
  for I := Low(Bounds32) to High(Bounds32) do
  begin
    CaseIndex := I;
    for J := 0 to 31 do Draw32(Bounds32[I]);
  end;
  for I := Low(Bounds64) to High(Bounds64) do
  begin
    CaseIndex := I;
    for J := 0 to 31 do Draw64(Bounds64[I]);
  end;
  { Every power-of-two transition and its signed neighbours. }
  for I := 0 to 31 do
  begin
    CaseIndex := I;
    Power32 := LongWord(1) shl I;
    for J := -2 to 2 do
    begin
      Draw32(LongInt(Power32 + LongWord(J)));
      Draw32(-LongInt(Power32 + LongWord(J)));
    end;
  end;
  for I := 0 to 63 do
  begin
    CaseIndex := I;
    Power64 := QWord(1) shl I;
    for J := -2 to 2 do
    begin
      Draw64(Int64(Power64 + QWord(Int64(J))));
      Draw64(-Int64(Power64 + QWord(Int64(J))));
    end;
  end;
  Stage := 'float-run';
  for I := 0 to 2047 do
  begin
    CaseIndex := I;
    DrawFloat;
  end;
end;

procedure MixedCases;
var
  I: LongInt;
  Choice, Seed: LongWord;
  A32: LongInt;
  A64: Int64;
begin
  Stage := 'mixed';
  for I := 0 to MixedDrawsPerSeed - 1 do
  begin
    CaseIndex := I;
    { Explicit reseeding during a mixed-width stream detects draw-consumption
      differences that a fresh seed before every operation would conceal. }
    if I mod 257 = 0 then
    begin
      case (I div 257) mod 5 of
        0: Seed := CurrentSeed;
        1: Seed := not CurrentSeed;
        2: Seed := LongWord(System.RandSeed);
        3: Seed := not LongWord(System.RandSeed);
        else Seed := NextInput;
      end;
      AssignSeed(Seed);
    end;
    Choice := NextInput;
    A32 := LongInt(NextInput);
    A64 := NextInput64;
    case (Choice shr 16) mod 6 of
      0: Draw32(A32);
      1: Draw64(A64);
      2: DrawFloat;
      3: Draw32(Bounds32[(Choice shr 8) mod Length(Bounds32)]);
      4: Draw64(Bounds64[(Choice shr 8) mod Length(Bounds64)]);
      5: DrawFloat;
    end;
  end;
end;

procedure Execute;
var
  I, J: LongInt;
  Seed: LongWord;
begin
  Digest := QWord($CBF29CE484222325);
  InputState := $97C29B3A;
  { This MUST be the first System.Random use in the process. Do not add an
    oracle warmup or alias/reset of the RTL's private state. }
  SimRandom.ResetOriginalRNG($FFFFFFFF);
  AssignSeed($FFFFFFFF);
  Stage := 'first-ffffffff';
  for I := 0 to 15 do
  begin
    CaseIndex := I;
    DrawFloat;
    Draw32(1073741825);
    Draw64(4611686018427387905);
    AssignSeed($FFFFFFFF);
  end;
  { Transition through the exact first-default/same/complement caveat. }
  Stage := 'default-reseed';
  for I := 0 to 7 do
  begin
    if (I and 2) = 0 then Seed := 0 else Seed := $FFFFFFFF;
    AssignSeed(Seed);
    CaseIndex := I;
    Draw32(0);
    Draw32(-1);
    Draw64(0);
    Draw64(-1);
    DrawFloat;
  end;
  for I := 0 to Length(FixedSeeds) + GeneratedSeeds - 1 do
  begin
    if I < Length(FixedSeeds) then Seed := FixedSeeds[I]
    else Seed := NextInput;
    AssignSeed(Seed);
    Inc(SeedCases);
    BoundaryCases;
    { Exhaust all signed 16-bit bounds, on representative seeds. }
    if I < 5 then
    begin
      Stage := 'exhaustive-int16-bounds';
      for J := -32768 to 32767 do
      begin
        CaseIndex := J;
        Draw32(J);
        Draw64(Int64(J));
      end;
    end;
    MixedCases;
    { A final uninterrupted fingerprint makes hidden draw-consumption drift
      visible even when the preceding operation returned a constant. }
    Stage := 'tail-fingerprint';
    for J := 0 to 127 do
    begin
      CaseIndex := J;
      Draw32(High(LongInt));
      Draw64(High(Int64));
      DrawFloat;
    end;
  end;
  ReportText := '{"status":"pass","mismatches":0,"seedCases":' + UIntToStr(SeedCases) +
    ',"seedAssignments":' + UIntToStr(Assignments) + ',"calls":' + UIntToStr(Calls) +
    ',"longint":' + UIntToStr(Count32) + ',"int64":' + UIntToStr(Count64) +
    ',"float64":' + UIntToStr(CountFloat) + ',"mixedDrawsPerSeed":' +
    IntToStr(MixedDrawsPerSeed) + ',"hash":"' + Hex64(Digest) + '"}';
end;

function RunRandomConformance: LongInt;
begin
  { System hidden state cannot be reset honestly; a second export call returns
    the original result instead of pretending to repeat the initial-state test. }
  if not HasRun then
  begin
    HasRun := True;
    try
      Execute;
      RunStatus := 0;
    except
      on E: EConformanceMismatch do RunStatus := 1;
      on E: Exception do
      begin
        ReportText := '{"status":"fail","mismatches":0,"error":"unexpected exception",' +
          '"call":' + UIntToStr(Calls) + ',"stage":"' + Stage + '"}';
        RunStatus := 2;
      end;
    end;
  end;
  Result := RunStatus;
end;

function RandomConformanceReport: PAnsiChar;
begin
  Result := PAnsiChar(ReportText);
end;

function RandomConformanceReportLength: LongWord;
begin
  Result := Length(ReportText);
end;

end.
