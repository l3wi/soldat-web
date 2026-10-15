unit Sound;
{$mode delphi}{$H+}
interface
uses Vector;
const CHANNEL_WEATHER = 127;
var DefaultChannel: LongInt = -1;
procedure PlaySound(Sample: Integer); overload;
procedure PlaySound(Sample, Channel: Integer); overload;
procedure PlaySound(Sample: Integer; const Emitter: TVector2); overload;
procedure PlaySound(Sample: Integer; const Emitter: TVector2; var Channel: Integer); overload;
function StopSound(Channel: Integer): Boolean;
function SetVolume(Channel: Integer; Volume: Single): Boolean;
function SetSoundPaused(Channel: Integer; Paused: Boolean): Boolean;
implementation
uses Constants, SimEvents;
type TSoundEvent = packed record
  Sample, Channel, Operation: LongInt;
  Flags: LongWord;
  X, Y, Volume, MaxDistance: Single;
end;
procedure Emit(Sample, Channel, Operation: Integer; const Emitter: TVector2; Volume: Single; NonPositional: Boolean);
var E: TSoundEvent;
begin
  E := Default(TSoundEvent);
  E.Sample := Sample; E.Channel := Channel; E.Operation := Operation;
  if Sample in [SFX_ROCKETZ, SFX_CHAINSAW_R, SFX_FLAMER] then E.Flags := 1;
  if NonPositional then E.Flags := E.Flags or 2;
  E.X := Emitter.X; E.Y := Emitter.Y; E.Volume := Volume;
  E.MaxDistance := SOUND_MAXDIST;
  SimEventEmit($80000004, 0, 0, @E, SizeOf(E));
end;
procedure PlaySound(Sample: Integer);
begin Emit(Sample, -1, 0, Vector2(0,0), 1, True); end;
procedure PlaySound(Sample, Channel: Integer);
begin Emit(Sample, Channel, 0, Vector2(0,0), 1, True); end;
procedure PlaySound(Sample: Integer; const Emitter: TVector2);
begin Emit(Sample, -1, 0, Emitter, 1, False); end;
procedure PlaySound(Sample: Integer; const Emitter: TVector2; var Channel: Integer);
begin Emit(Sample, Channel, 0, Emitter, 1, False); end;
function StopSound(Channel: Integer): Boolean;
begin Emit(0,Channel,1,Vector2(0,0),0,True); Result := False; end;
function SetVolume(Channel: Integer; Volume: Single): Boolean;
begin Emit(0,Channel,2,Vector2(0,0),Volume,True); Result := True; end;
function SetSoundPaused(Channel: Integer; Paused: Boolean): Boolean;
begin Emit(0,Channel,3+Ord(not Paused),Vector2(0,0),1,True); Result := True; end;
end.
