unit SpikeCore;
{$mode delphi}{$Q-}
interface
const StateFloats = 96;
type TSpikeState = array[0..StateFloats - 1] of Single;
var State: TSpikeState;
procedure spike_reset; cdecl;
function spike_step: QWord; cdecl;
function spike_run(Ticks: LongWord): QWord; cdecl;
function spike_state_ptr: Pointer; cdecl;
function spike_state_len: LongWord; cdecl;
implementation
uses Vector, Calc, Parts;
var
  EulerSystem, VerletSystem: ParticleSystem;
  Tick: LongWord;

procedure Capture;
var S, I, K: Integer; P: ^ParticleSystem; A, D: TVector2;
begin
  K := 0;
  for S := 0 to 1 do
  begin
    if S = 0 then P := @EulerSystem else P := @VerletSystem;
    for I := 1 to 5 do
    begin
      State[K] := P^.Pos[I].X; Inc(K);
      State[K] := P^.Pos[I].Y; Inc(K);
      State[K] := P^.Velocity[I].X; Inc(K);
      State[K] := P^.Velocity[I].Y; Inc(K);
      State[K] := P^.OldPos[I].X; Inc(K);
      State[K] := P^.OldPos[I].Y; Inc(K);
      State[K] := P^.Forces[I].X; Inc(K);
      State[K] := P^.Forces[I].Y; Inc(K);
      State[K] := P^.OneOverMass[I]; Inc(K);
    end;
  end;
  A := Vec2Subtract(EulerSystem.Pos[5], EulerSystem.Pos[1]);
  State[90] := Vec2Length(A);
  State[91] := Angle2Points(EulerSystem.Pos[1], EulerSystem.Pos[5]);
  State[92] := Sin(State[91]);
  State[93] := Cos(State[91]);
  Vec2Normalize(D, A);
  State[94] := D.X;
  State[95] := D.Y;
end;

function StateHash: QWord;
var I: Integer; Bytes: PByte;
begin
  Result := QWord($CBF29CE484222325);
  Bytes := @State[0];
  for I := 0 to SizeOf(State) - 1 do
    Result := (Result xor Bytes[I]) * QWord($100000001B3);
end;

procedure spike_reset; cdecl;
var I: Integer; Start, Velocity: TVector2;
begin
  FillChar(EulerSystem, SizeOf(EulerSystem), 0);
  FillChar(VerletSystem, SizeOf(VerletSystem), 0);
  EulerSystem.TimeStep := 1;
  EulerSystem.GravityMultiplier := 1;
  EulerSystem.EDamping := 0.98;
  VerletSystem.TimeStep := 1;
  VerletSystem.GravityMultiplier := 0.8;
  VerletSystem.VDamping := 0.99;
  for I := 1 to 5 do
  begin
    Start := Vector2(I * 3.25, I * -1.5);
    Velocity := Vector2(I * 0.015, I * -0.01);
    EulerSystem.CreatePart(Start, Velocity, 0.75 + I * 0.25, I);
    VerletSystem.CreatePart(Start, Velocity, 1 + I * 0.25, I);
    if I > 1 then
    begin
      EulerSystem.MakeConstraint(I - 1, I, 3.6);
      VerletSystem.MakeConstraint(I - 1, I, 3.6);
    end;
  end;
  Tick := 0;
  Capture;
end;

function spike_step: QWord; cdecl;
var I: Integer; Phase: Single;
begin
  Inc(Tick);
  for I := 1 to 5 do
  begin
    Phase := Tick * 0.01 + I * 0.125;
    EulerSystem.Forces[I].X := Sin(Phase) * 0.002;
    VerletSystem.Forces[I].X := Cos(Phase) * 0.002;
  end;
  EulerSystem.DoEulerTimeStep;
  EulerSystem.SatisfyConstraints;
  VerletSystem.DoVerletTimeStep;
  Capture;
  Result := StateHash;
end;

function spike_run(Ticks: LongWord): QWord; cdecl;
var I: LongWord;
begin
  spike_reset;
  Result := StateHash;
  for I := 1 to Ticks do Result := spike_step;
end;

function spike_state_ptr: Pointer; cdecl;
begin Result := @State[0]; end;
function spike_state_len: LongWord; cdecl;
begin Result := SizeOf(State); end;
end.
