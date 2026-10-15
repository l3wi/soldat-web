unit Demo;
interface
type
  TDemoRecorder = class
  private
    FActive: Boolean;
    FTicksNum: Integer;
  public
    function StartRecord(Filename: string): Boolean;
    procedure StopRecord;
    procedure SaveRecord(var R; Size: Integer);
    procedure SaveNextFrame;
    property Active: Boolean read FActive write FActive;
    property TicksNum: Integer read FTicksNum;
  end;
var DemoRecorder: TDemoRecorder;
implementation
uses SysUtils;
function TDemoRecorder.StartRecord(Filename: string): Boolean;
begin
  Result := False;
  raise ENotSupportedException.Create('Demo recording is not supported by the simulation');
end;
procedure TDemoRecorder.StopRecord;
begin FActive := False; FTicksNum := 0; end;
procedure TDemoRecorder.SaveRecord(var R; Size: Integer);
begin
  if FActive then raise ENotSupportedException.Create('Demo recording is not supported by the simulation');
end;
procedure TDemoRecorder.SaveNextFrame;
begin
  if FActive then raise ENotSupportedException.Create('Demo recording is not supported by the simulation');
end;
initialization DemoRecorder := TDemoRecorder.Create;
finalization DemoRecorder.Free;
end.
