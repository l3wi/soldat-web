unit PhysFS;

interface

uses Classes, SysUtils;

type
  PHYSFS_File = Pointer;
  PHYSFS_Buffer = array of Byte;

procedure SimVFSReset;
function SimVFSPut(const Path: AnsiString; Data: Pointer; Size: LongWord): Boolean;
function SimVFSHash: QWord;
function PHYSFS_init(argv0: PChar): LongBool; cdecl;
function PHYSFS_deinit: LongInt; cdecl;
function PHYSFS_mount(newDir, mountPoint: PChar; appendToPath: LongBool): LongBool; cdecl;
function PHYSFS_removeFromSearchPath(oldDir: PChar): LongBool; cdecl;
function PHYSFS_openRead(filename: PChar): PHYSFS_File; cdecl;
function PHYSFS_exists(filename: PChar): LongBool; cdecl;
function PHYSFS_eof(pfile: PHYSFS_File): LongBool; cdecl;
function PHYSFS_read(pfile: PHYSFS_File; buffer: Pointer; obj_size, obj_count: LongWord): Int64; cdecl;
function PHYSFS_close(pfile: PHYSFS_File): Int64; cdecl;
function PHYSFS_getLastError: PChar; cdecl;
function PHYSFS_fileLength(pfile: PHYSFS_File): Int64; cdecl;
function PHYSFS_enumerateFiles(const dir: PChar): PPChar; cdecl;
procedure PHYSFS_freeList(listVar: PPChar); cdecl;
function PHYSFS_readBuffer(Name: PChar): PHYSFS_Buffer;
function PHYSFS_readAsStream(Name: PChar): TStream;
procedure PHYSFS_ReadLn(FileHandle: PHYSFS_File; var Line: AnsiString);
function PHYSFS_CopyFileFromArchive(SourceFile, Destination: AnsiString): Boolean;
function PHYSFS_CopyFilesFromArchiveDirectory(SourceDirectory, DestinationDirectory: AnsiString): Boolean;
function PHYSFS_GetEnumeratedFiles(Dir: string): TStringArray;

implementation

type
  TVFSFile = class
    Data: PHYSFS_Buffer;
    Digest: QWord;
  end;
  TVFSReader = class(TCustomMemoryStream)
  private
    FData: PHYSFS_Buffer;
  public
    constructor Create(const Data: PHYSFS_Buffer);
    function Write(const Buffer; Count: LongInt): LongInt; override;
  end;

var
  Files: TStringList;
  LastError: AnsiString;
  Identity: QWord;

constructor TVFSReader.Create(const Data: PHYSFS_Buffer);
begin
  inherited Create;
  FData := Data;
  if Length(FData) = 0 then SetPointer(nil, 0)
  else SetPointer(@FData[0], Length(FData));
end;

function TVFSReader.Write(const Buffer; Count: LongInt): LongInt;
begin
  raise EStreamError.Create('VFS read streams are immutable');
end;

function SimVFSHash: QWord;
begin
  Result := Identity;
end;

{$PUSH}{$Q-}{$R-}
function FileDigest(const Path: AnsiString; const Data: PHYSFS_Buffer): QWord;
var
  I: SizeInt;
  N: LongWord;
begin
  Result := QWord($CBF29CE484222325);
  N := Length(Path);
  for I := 0 to 3 do Result := (Result xor ((N shr (I * 8)) and $FF)) * QWord($100000001B3);
  for I := 1 to Length(Path) do Result := (Result xor Byte(Path[I])) * QWord($100000001B3);
  N := Length(Data);
  for I := 0 to 3 do Result := (Result xor ((N shr (I * 8)) and $FF)) * QWord($100000001B3);
  for I := 0 to High(Data) do Result := (Result xor Data[I]) * QWord($100000001B3);
end;
{$POP}

function Canonical(const Path: AnsiString): AnsiString;
var
  I: Integer;
  Segment: AnsiString;
begin
  Result := '';
  Segment := '';
  for I := 1 to Length(Path) + 1 do
  begin
    if (I > Length(Path)) or (Path[I] = '/') or (Path[I] = '\') then
    begin
      if Segment = '..' then Exit('');
      if (Segment <> '') and (Segment <> '.') then
      begin
        if Result <> '' then Result := Result + '/';
        Result := Result + LowerCase(Segment);
      end;
      Segment := '';
    end
    else Segment := Segment + Path[I];
  end;
end;

procedure SimVFSReset;
var I: Integer;
begin
  for I := 0 to Files.Count - 1 do Files.Objects[I].Free;
  Files.Clear;
  LastError := '';
  Identity := 0;
end;

function SimVFSPut(const Path: AnsiString; Data: Pointer; Size: LongWord): Boolean;
var
  Key: AnsiString;
  Index: Integer;
  Entry: TVFSFile;
begin
  Result := False;
  Key := Canonical(Path);
  if (Key = '') or ((Size <> 0) and (Data = nil)) then
  begin
    LastError := 'Invalid VFS path or data';
    Exit;
  end;
  Entry := TVFSFile.Create;
  try
    SetLength(Entry.Data, Size);
    if Size <> 0 then Move(Data^, Entry.Data[0], Size);
    Entry.Digest := FileDigest(Key, Entry.Data);
    Index := Files.IndexOf(Key);
    if Index < 0 then Files.AddObject(Key, Entry)
    else
    begin
      Identity := Identity xor TVFSFile(Files.Objects[Index]).Digest;
      Files.Objects[Index].Free;
      Files.Objects[Index] := Entry;
    end;
    Identity := Identity xor Entry.Digest;
  except
    Entry.Free;
    raise;
  end;
  Result := True;
end;

function PHYSFS_init(argv0: PChar): LongBool; cdecl;
begin
  Result := True;
end;

function PHYSFS_deinit: LongInt; cdecl;
begin
  SimVFSReset;
  Result := 1;
end;

function PHYSFS_mount(newDir, mountPoint: PChar; appendToPath: LongBool): LongBool; cdecl;
begin
  LastError := 'Mounting host files is unsupported; supply VFS bytes';
  Result := False;
end;

function PHYSFS_removeFromSearchPath(oldDir: PChar): LongBool; cdecl;
begin
  LastError := 'VFS has no mounted search paths';
  Result := False;
end;

function PHYSFS_exists(filename: PChar): LongBool; cdecl;
begin
  Result := (filename <> nil) and (Files.IndexOf(Canonical(AnsiString(filename))) >= 0);
end;

function PHYSFS_openRead(filename: PChar): PHYSFS_File; cdecl;
var
  Index: Integer;
  Entry: TVFSFile;
  Reader: TVFSReader;
begin
  Result := nil;
  if filename = nil then Exit;
  Index := Files.IndexOf(Canonical(AnsiString(filename)));
  if Index < 0 then
  begin
    LastError := 'VFS file not found: ' + AnsiString(filename);
    Exit;
  end;
  Entry := TVFSFile(Files.Objects[Index]);
  Reader := TVFSReader.Create(Entry.Data);
  Result := Pointer(Reader);
end;

function PHYSFS_eof(pfile: PHYSFS_File): LongBool; cdecl;
begin
  Result := (pfile = nil) or (TVFSReader(pfile).Position >= TVFSReader(pfile).Size);
end;

function PHYSFS_read(pfile: PHYSFS_File; buffer: Pointer; obj_size, obj_count: LongWord): Int64; cdecl;
var
  Reader: TVFSReader;
  Objects, Bytes: Int64;
begin
  Result := -1;
  if (pfile = nil) or ((buffer = nil) and (obj_size <> 0) and (obj_count <> 0)) then Exit;
  if (obj_size = 0) or (obj_count = 0) then Exit(0);
  Reader := TVFSReader(pfile);
  Objects := (Reader.Size - Reader.Position) div obj_size;
  if Objects > obj_count then Objects := obj_count;
  Bytes := Objects * obj_size;
  if Bytes > High(LongInt) then
  begin
    LastError := 'VFS read exceeds stream capacity';
    Exit;
  end;
  if Bytes <> 0 then Reader.ReadBuffer(buffer^, LongInt(Bytes));
  Result := Objects;
end;

function PHYSFS_close(pfile: PHYSFS_File): Int64; cdecl;
begin
  Result := 0;
  if pfile = nil then Exit;
  TVFSReader(pfile).Free;
  Result := 1;
end;

function PHYSFS_getLastError: PChar; cdecl;
begin
  Result := PChar(LastError);
end;

function PHYSFS_fileLength(pfile: PHYSFS_File): Int64; cdecl;
begin
  if pfile = nil then Result := -1 else Result := TVFSReader(pfile).Size;
end;

function PHYSFS_readBuffer(Name: PChar): PHYSFS_Buffer;
var Reader: PHYSFS_File; Size: Int64;
begin
  Result := nil;
  Reader := PHYSFS_openRead(Name);
  if Reader = nil then Exit;
  try
    Size := PHYSFS_fileLength(Reader);
    SetLength(Result, Size);
    if Size <> 0 then PHYSFS_read(Reader, @Result[0], 1, Size);
  finally PHYSFS_close(Reader); end;
end;

function PHYSFS_readAsStream(Name: PChar): TStream;
begin
  Result := TStream(PHYSFS_openRead(Name));
end;

procedure PHYSFS_ReadLn(FileHandle: PHYSFS_File; var Line: AnsiString);
var
  Reader: TVFSReader;
  Data: PByte;
  First, Last, I, Count: SizeInt;
begin
  Line := '';
  if FileHandle = nil then Exit;
  Reader := TVFSReader(FileHandle);
  Data := Reader.Memory;
  First := Reader.Position;
  Last := First;
  Count := 0;
  while Last < Reader.Size do
  begin
    if Data[Last] = 10 then Break;
    if Data[Last] <> 13 then Inc(Count);
    Inc(Last);
  end;
  SetLength(Line, Count);
  Count := 0;
  for I := First to Last - 1 do
    if Data[I] <> 13 then
    begin
      Inc(Count);
      Line[Count] := AnsiChar(Data[I]);
    end;
  if Last < Reader.Size then Inc(Last);
  Reader.Position := Last;
end;

function PHYSFS_GetEnumeratedFiles(Dir: string): TStringArray;
var
  Names: TStringList;
  Prefix, Name: AnsiString;
  I, Slash: Integer;
begin
  Names := TStringList.Create;
  try
    Names.Sorted := True;
    Names.Duplicates := dupIgnore;
    Prefix := Canonical(Dir);
    if Prefix <> '' then Prefix := Prefix + '/';
    for I := 0 to Files.Count - 1 do
      if Copy(Files[I], 1, Length(Prefix)) = Prefix then
      begin
        Name := Copy(Files[I], Length(Prefix) + 1, MaxInt);
        Slash := Pos('/', Name);
        if Slash <> 0 then SetLength(Name, Slash - 1);
        if Name <> '' then Names.Add(Name);
      end;
    SetLength(Result, Names.Count);
    for I := 0 to Names.Count - 1 do Result[I] := Names[I];
  finally Names.Free; end;
end;

function PHYSFS_enumerateFiles(const dir: PChar): PPChar; cdecl;
var Names: TStringArray; I: Integer;
begin
  Names := PHYSFS_GetEnumeratedFiles(AnsiString(dir));
  GetMem(Result, (Length(Names) + 1) * SizeOf(PChar));
  for I := 0 to High(Names) do Result[I] := StrNew(PChar(Names[I]));
  Result[Length(Names)] := nil;
end;

procedure PHYSFS_freeList(listVar: PPChar); cdecl;
var I: Integer;
begin
  if listVar = nil then Exit;
  I := 0;
  while listVar[I] <> nil do
  begin
    StrDispose(listVar[I]);
    Inc(I);
  end;
  FreeMem(listVar);
end;

function PHYSFS_CopyFileFromArchive(SourceFile, Destination: AnsiString): Boolean;
var Data: PHYSFS_Buffer;
begin
  Result := False;
  if not PHYSFS_exists(PChar(SourceFile)) or PHYSFS_exists(PChar(Destination)) then Exit;
  Data := PHYSFS_readBuffer(PChar(SourceFile));
  if Length(Data) = 0 then Result := SimVFSPut(Destination, nil, 0)
  else Result := SimVFSPut(Destination, @Data[0], Length(Data));
end;

function PHYSFS_CopyFilesFromArchiveDirectory(SourceDirectory, DestinationDirectory: AnsiString): Boolean;
var Names: TStringArray; I: Integer;
begin
  Names := PHYSFS_GetEnumeratedFiles(SourceDirectory);
  Result := Length(Names) <> 0;
  for I := 0 to High(Names) do
    if not PHYSFS_CopyFileFromArchive(SourceDirectory + '/' + Names[I], DestinationDirectory + '/' + Names[I]) then
      Result := False;
end;

initialization
  Files := TStringList.Create;
  Files.Sorted := True;
  Files.CaseSensitive := True;
finalization
  SimVFSReset;
  Files.Free;
end.
