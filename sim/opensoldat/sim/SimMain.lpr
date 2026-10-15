library SimMain;
{$mode delphi}
uses SimCore;
{ wasm32 FPC requires exported wrappers declared in this library, not merely
  exports referring to another unit (G0.2; humanova/soldat-web MIT recipe). }
function sim_version: LongWord; cdecl;
begin Result := SimCore.sim_version; end;
function sim_alloc(Size: LongWord): Pointer; cdecl;
begin Result := SimCore.sim_alloc(Size); end;
procedure sim_free(Buffer: Pointer); cdecl;
begin SimCore.sim_free(Buffer); end;
function sim_vfs_put(Path: Pointer; PathLength: LongWord; Data: Pointer; DataLength: LongWord): LongInt; cdecl;
begin Result := SimCore.sim_vfs_put(Path,PathLength,Data,DataLength); end;
function sim_init(Rules: Pointer; RulesLength, SeedLo, SeedHi, Flags: LongWord): LongInt; cdecl;
begin Result := SimCore.sim_init(Rules,RulesLength,SeedLo,SeedHi,Flags); end;
function sim_load_map(Name: Pointer; NameLength: LongWord): LongInt; cdecl;
begin Result := SimCore.sim_load_map(Name,NameLength); end;
function sim_command(Tick: LongWord; Data: Pointer; Length: LongWord): LongInt; cdecl;
begin Result := SimCore.sim_command(Tick,Data,Length); end;
function sim_set_input(Slot, Tick: LongWord; Data: Pointer): LongInt; cdecl;
begin Result := SimCore.sim_set_input(Slot,Tick,Data); end;
function sim_step(Flags: LongWord): LongInt; cdecl;
begin Result := SimCore.sim_step(Flags); end;
function sim_events(Buffer: Pointer; Capacity: LongWord): LongInt; cdecl;
begin Result := SimCore.sim_events(Buffer,Capacity); end;
function sim_render_view: Pointer; cdecl;
begin Result := SimCore.sim_render_view; end;
function sim_save_state(Buffer: Pointer; Capacity: LongWord): LongInt; cdecl;
begin Result := SimCore.sim_save_state(Buffer,Capacity); end;
function sim_load_state(Buffer: Pointer; Length: LongWord): LongInt; cdecl;
begin Result := SimCore.sim_load_state(Buffer,Length); end;
function sim_hash_state: QWord; cdecl;
begin Result := SimCore.sim_hash_state; end;
function sim_trace_state(Buffer: Pointer; Capacity: LongWord): LongInt; cdecl;
begin Result := SimCore.sim_trace_state(Buffer,Capacity); end;
function fx_step: LongInt; cdecl;
begin Result := SimCore.fx_step; end;
function fx_render_view: LongInt; cdecl;
begin Result := SimCore.fx_render_view; end;
function fx_set_view(X,Y,Width,Height:Single;Slot:LongWord):LongInt;cdecl;
begin Result:=SimCore.fx_set_view(X,Y,Width,Height,Slot);end;
exports
  sim_version,
  sim_alloc,
  sim_free,
  sim_vfs_put,
  sim_init,
  sim_load_map,
  sim_command,
  sim_set_input,
  sim_step,
  sim_events,
  sim_render_view,
  sim_save_state,
  sim_load_state,
  sim_hash_state,
  sim_trace_state,
  fx_step,
  fx_render_view,
  fx_set_view;
begin
end.
