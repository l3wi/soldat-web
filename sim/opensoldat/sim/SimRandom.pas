unit SimRandom;
{$mode delphi}
{$H+}
{$Q-}
{$R-}

interface

{ Portable simulation RNG. These six words are the complete serialized state. }
var
  RandSeed: LongWord = 0;
  OldRandSeed: LongWord = $FFFFFFFF;
  RandomState: array[0..3] of LongWord =
    ($AFF181C0, $73B13BA2, $1340D3B4, $61204305);
  KeyedEnabled: Boolean = False;
  MatchSeed, OtherCounter, AISeed: QWord;
  ShotCounters, EventCounters: array[0..32] of LongWord;

procedure SetRandomPolicy(Keyed:Boolean;SeedLo,SeedHi:LongWord);
procedure BeginRandomEvent(Entity,Domain:LongWord;Shot:Boolean=False);
procedure EndRandomEvent;

procedure ResetOriginalRNG(Seed: LongWord);
function Random: Extended; overload;
function Random(Bound: LongInt): LongInt; overload;
function Random(Bound: Int64): Int64; overload;

implementation

{ The generator algorithms are from the public-domain reference algorithms:
    SplitMix64: Sebastiano Vigna (2015)
      https://prng.di.unimi.it/splitmix64.c
    xoshiro128** 1.1: David Blackman and Sebastiano Vigna (2018)
      https://prng.di.unimi.it/xoshiro128starstar.c
  The signed bounds, rejection policy, floating-point distribution and lazy
  reseeding below independently implement the pinned FPC simulation policy;
  no RTL source text or private object layout is used. Integer arithmetic in
  this unit deliberately wraps, regardless of the caller's compiler options. }

type TRandomContext=record State:QWord; end;
var Contexts:array[0..15] of TRandomContext; ContextDepth:Integer;

procedure SetRandomPolicy(Keyed:Boolean;SeedLo,SeedHi:LongWord);
begin
  KeyedEnabled:=Keyed; MatchSeed:=(QWord(SeedHi) shl 32) or SeedLo;
  FillChar(ShotCounters,SizeOf(ShotCounters),0);
  FillChar(EventCounters,SizeOf(EventCounters),0);
  OtherCounter:=0; AISeed:=MatchSeed xor QWord($41495F5354524541); ContextDepth:=0;
end;
procedure ResetOriginalRNG(Seed: LongWord);
begin
  { Restore startup state without drawing or eagerly expanding the seed.
    In particular, an initial $FFFFFFFF seed bypasses lazy reseeding. }
  OldRandSeed := $FFFFFFFF;
  RandomState[0] := $AFF181C0;
  RandomState[1] := $73B13BA2;
  RandomState[2] := $1340D3B4;
  RandomState[3] := $61204305;
  RandSeed := Seed;
end;

function SplitMixWord(var Seed: QWord): QWord; inline;
var
  Mixed: QWord;
begin
  Seed := Seed + QWord($9E3779B97F4A7C15);
  Mixed := (Seed xor (Seed shr 30)) * QWord($BF58476D1CE4E5B9);
  Mixed := (Mixed xor (Mixed shr 27)) * QWord($94D049BB133111EB);
  Result := Mixed xor (Mixed shr 31);
end;
procedure BeginRandomEvent(Entity,Domain:LongWord;Shot:Boolean);
var Counter:LongWord; Seed:QWord;
begin
  if not KeyedEnabled then Exit;
  if Entity>32 then Entity:=0;
  if ContextDepth=Length(Contexts) then RunError(202);
  if Shot then begin Counter:=ShotCounters[Entity];Inc(ShotCounters[Entity]);end
  else begin Counter:=EventCounters[Entity];Inc(EventCounters[Entity]);end;
  Seed:=MatchSeed xor (QWord(Entity) shl 48) xor (QWord(Domain) shl 32) xor Counter;
  Contexts[ContextDepth].State:=SplitMixWord(Seed);Inc(ContextDepth);
end;
procedure EndRandomEvent;
begin
  if not KeyedEnabled then Exit;
  if ContextDepth=0 then RunError(202);
  Dec(ContextDepth);
end;
function DrawKeyedWord:LongWord;
var Value:QWord;
begin
  if ContextDepth=0 then begin
    Value:=MatchSeed xor QWord($4F544845525F524E) xor OtherCounter;Inc(OtherCounter);
    Value:=SplitMixWord(Value);
  end else Value:=SplitMixWord(Contexts[ContextDepth-1].State);
  Result:=LongWord(Value shr 32);
end;

procedure ExpandSeed;
var
  Seed, Pair: QWord;
  PairIndex: Integer;
begin
  { RandSeed is the original unsigned 32-bit public seed. Its expansion
    must never sign-extend high-bit seeds into SplitMix64. }
  Seed := RandSeed;
  for PairIndex := 0 to 1 do
  begin
    Pair := SplitMixWord(Seed);
    RandomState[PairIndex * 2] := LongWord(Pair);
    RandomState[PairIndex * 2 + 1] := LongWord(Pair shr 32);
  end;
  RandSeed := not RandSeed;
  OldRandSeed := LongWord(RandSeed);
end;

function RotateLeft32(Value: LongWord; Bits: Byte): LongWord; inline;
begin
  Result := (Value shl Bits) or (Value shr (32 - Bits));
end;

function DrawWord: LongWord; inline;
var
  Shifted: LongWord;
begin
  if KeyedEnabled then Exit(DrawKeyedWord);
  if LongWord(RandSeed) <> OldRandSeed then
    ExpandSeed;

  Result := RotateLeft32(RandomState[1] * LongWord(5), 7) * LongWord(9);
  Shifted := RandomState[1] shl 9;
  RandomState[2] := RandomState[2] xor RandomState[0];
  RandomState[3] := RandomState[3] xor RandomState[1];
  RandomState[1] := RandomState[1] xor RandomState[2];
  RandomState[0] := RandomState[0] xor RandomState[3];
  RandomState[2] := RandomState[2] xor Shifted;
  RandomState[3] := RotateLeft32(RandomState[3], 11);
end;

function DrawDoubleWord: QWord; inline;
var
  Upper: LongWord;
begin
  { Separate calls guarantee high-word-first consumption on every target. }
  Upper := DrawWord;
  Result := (QWord(Upper) shl 32) or DrawWord;
end;

procedure MultiplyWide(Left, Right: QWord; out Lower, Upper: QWord); inline;
var
  LeftLow, LeftHigh, RightLow, RightHigh: QWord;
  Bottom, Cross, Carry: QWord;
begin
  { Base-2^32 schoolbook multiplication; no target-specific 128-bit type.
    Each intermediate fits in 64 bits before intentional final wrapping. }
  LeftLow := LongWord(Left);
  LeftHigh := Left shr 32;
  RightLow := LongWord(Right);
  RightHigh := Right shr 32;
  Bottom := LeftLow * RightLow;
  Cross := LeftHigh * RightLow + (Bottom shr 32);
  Carry := Cross shr 32;
  Cross := LeftLow * RightHigh + LongWord(Cross);
  Upper := LeftHigh * RightHigh + Carry + (Cross shr 32);
  Lower := (Cross shl 32) or LongWord(Bottom);
end;

function Random(Bound: LongInt): LongInt;
var
  Limit, Threshold: LongWord;
  Product: QWord;
begin
  if Bound < 0 then
    Limit := LongWord(-(Bound + 1))
  else
    Limit := LongWord(Bound);

  { Even bounds 0, 1 and -1 consume one word. The slow path only executes
    for a nonzero limit, so its remainder can never divide by zero. }
  Product := QWord(DrawWord) * Limit;
  if LongWord(Product) < Limit then
  begin
    Threshold := (not Limit + LongWord(1)) mod Limit;
    while LongWord(Product) < Threshold do
      Product := QWord(DrawWord) * Limit;
  end;
  Result := LongInt(Product shr 32);
  if Bound < -1 then
    Result := -Result - 1;
end;

function Random(Bound: Int64): Int64;
var
  Limit, Threshold, Lower, Upper: QWord;
begin
  { Small Int64 bounds deliberately share both values and consumption with
    the 32-bit overload, including all degenerate bounds. }
  if (Bound >= Low(LongInt)) and (Bound <= High(LongInt)) then
    Exit(Random(LongInt(Bound)));

  if Bound < 0 then
    Limit := QWord(-(Bound + 1))
  else
    Limit := QWord(Bound);
  MultiplyWide(DrawDoubleWord, Limit, Lower, Upper);
  if Lower < Limit then
  begin
    Threshold := (not Limit + QWord(1)) mod Limit;
    while Lower < Threshold do
      MultiplyWide(DrawDoubleWord, Limit, Lower, Upper);
  end;
  Result := Int64(Upper);
  if Bound < -1 then
    Result := -Result - 1;
end;

function LeadingZeros(Value: LongWord): LongWord; inline;
begin
  { Only nonzero values reach this helper. }
  Result := 0;
  if Value shr 16 = 0 then
  begin
    Inc(Result, 16);
    Value := Value shl 16;
  end;
  if Value shr 24 = 0 then
  begin
    Inc(Result, 8);
    Value := Value shl 8;
  end;
  if Value shr 28 = 0 then
  begin
    Inc(Result, 4);
    Value := Value shl 4;
  end;
  if Value shr 30 = 0 then
  begin
    Inc(Result, 2);
    Value := Value shl 2;
  end;
  if Value shr 31 = 0 then
    Inc(Result);
end;

function Random: Extended;
var
  First, Tail, ZeroCount: LongWord;
  Bits: QWord;
  Value: Double absolute Bits;
begin
  First := DrawWord;
  Bits := (QWord(First and $000FFFFF) shl 32) or DrawWord;

  { The unused top twelve bits choose a geometric binary exponent. If all
    are zero, continue with whole words after the two mantissa draws.
    The fifty-two mantissa bits remain independent of that exponent. }
  Tail := First shr 20;
  if Tail <> 0 then
    ZeroCount := LeadingZeros(Tail) - 20
  else
  begin
    ZeroCount := 12;
    Tail := DrawWord;
    while Tail = 0 do
    begin
      Inc(ZeroCount, 32);
      Tail := DrawWord;
    end;
    Inc(ZeroCount, LeadingZeros(Tail));
  end;
  Bits := Bits or (QWord(LongWord(1022) - ZeroCount) shl 52);
  Result := Value;
end;

end.
