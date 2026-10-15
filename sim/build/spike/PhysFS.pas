{ Spike-only absent VFS. File loading is deliberately outside this experiment. }
unit PhysFS;
interface
type PHYSFS_File = Pointer;
function PHYSFS_Exists(Path: PChar): Boolean;
function PHYSFS_openRead(Path: PChar): PHYSFS_File;
procedure PhysFS_ReadLN(F: PHYSFS_File; var Line: string);
function PHYSFS_close(F: PHYSFS_File): Integer;
implementation
uses SysUtils;
function PHYSFS_Exists(Path: PChar): Boolean;
begin Result := False; end;
function PHYSFS_openRead(Path: PChar): PHYSFS_File;
begin raise Exception.Create('Spike has no VFS'); end;
procedure PhysFS_ReadLN(F: PHYSFS_File; var Line: string);
begin raise Exception.Create('Spike has no VFS'); end;
function PHYSFS_close(F: PHYSFS_File): Integer;
begin raise Exception.Create('Spike has no VFS'); end;
end.
