unit SimFXRandom;
{$mode delphi}{$Q-}{$R-}
interface
var SimFXAllowed:Boolean=True;
procedure ResetFXRandom(Seed: LongWord);
function FXRandom(Bound: LongInt): LongInt; overload;
function FXRandom: Extended; overload;
function FXRandomRange(A,B:Integer):Integer;
implementation
var State: LongWord = $A341316C;
procedure ResetFXRandom(Seed: LongWord);
begin State := Seed xor $A341316C; if State = 0 then State := 1; end;
function WordValue: LongWord;
begin
  State := State xor (State shl 13);
  State := State xor (State shr 17);
  State := State xor (State shl 5);
  Result := State;
end;
function FXRandom(Bound: LongInt): LongInt;
begin
  if Bound <= 0 then begin WordValue; Exit(0); end;
  Result := (QWord(WordValue) * LongWord(Bound)) shr 32;
end;
function FXRandom: Extended;
begin Result := Double(WordValue) / 4294967296.0; end;
function FXRandomRange(A,B:Integer):Integer;
begin if A<B then Result:=A+FXRandom(B-A) else Result:=B+FXRandom(A-B);end;
end.
