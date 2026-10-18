{ OpenSoldat Sparks mechanics extracted from shared/mechanics/Sparks.pas.
  Original copyright (c) 2003 Michal Marcinkowski; 2020-2023 OpenSoldat contributors.
  MIT. Rendering is exposed as data; camera culling/wobble belongs to the host. }
unit Sparks;
{$mode delphi}{$H+}
interface
uses Vector, Parts, Sprites;
type
  TSpark = object
    Active: Boolean;
    Num: SmallInt;
    LifeReal: Single;
    Life, LifePrev, Style, Owner, CollideCount: Byte;
    procedure Update;
    function CheckMapCollision(X,Y: Single): Boolean;
    procedure Kill;
    procedure CheckOutOfBounds;
  end;
function CreateSpark(sPos,sVelocity: TVector2; sStyle,sOwner: Byte; Life: Integer): Integer;
procedure SimFXReset(Seed: LongWord);
procedure SimFXClear;
procedure SimFXReplay(Value: Boolean);
procedure SimFXSetView(X,Y,Width,Height: Single);
function SimFXStep: LongInt;
function SimFXRenderView: Pointer;
var SparksCount: Integer;
implementation
uses Math, Constants, Cvar, PolyMap, Game, Sound, SimFXRandom, SimRender, Net, SimPresentation;
const FX_STRIDE=64; FX_BYTES=32+MAX_SPARKS*FX_STRIDE; QUEUE_CAPACITY=8192;
type
  TRequest = record Position, Velocity: TVector2; Style,Owner: Byte; Life: Integer; end;
var
  Spark: array[1..MAX_SPARKS] of TSpark;
  Requests: array[0..QUEUE_CAPACITY-1] of TRequest;
  RequestCount: Integer;
  Replaying, Updating: Boolean;
  LastTick: LongInt = -1;
  CameraX,CameraY: Single;
  ViewWidth: Single=854; ViewHeight: Single=480;
  View: array[0..FX_BYTES-1] of Byte;
function Activate(sPos,sVelocity: TVector2; sStyle,sOwner: Byte; Life: Integer): Integer;
var I: Integer;
begin
  Result:=0;
  if (Life<1) or (Life>255) then Exit;
  for I:=1 to r_maxsparks.Value+1 do
  begin
    if (SparksCount>r_maxsparks.Value-50) and (sStyle in [2,3,4,26,27,59]) then Exit;
    if (SparksCount>r_maxsparks.Value-40) and (sStyle=1) then Exit;
    if (SparksCount>r_maxsparks.Value-30) and (sStyle=24) then Exit;
    if I=r_maxsparks.Value then begin Result:=FXRandom(r_maxsparks.Value div 3)+1; Break; end;
    if not Spark[I].Active and (Spark[I].Style=0) and not SparkParts.Active[I] then
      begin Result:=I; Break; end;
  end;
  I:=Result;
  Spark[I].Active:=True; Spark[I].Life:=Life; Spark[I].LifePrev:=Life;
  Spark[I].Style:=sStyle; Spark[I].Num:=I; Spark[I].Owner:=sOwner;
  Spark[I].CollideCount:=0;
  SparkParts.CreatePart(sPos,sVelocity,1,I);
end;
function CreateSpark(sPos,sVelocity: TVector2; sStyle,sOwner: Byte; Life: Integer): Integer;
begin
  Result:=0;
  if Replaying then Exit;
  if Updating then Exit(Activate(sPos,sVelocity,sStyle,sOwner,Life));
  if RequestCount=QUEUE_CAPACITY then Exit;
  Requests[RequestCount].Position:=sPos; Requests[RequestCount].Velocity:=sVelocity;
  Requests[RequestCount].Style:=sStyle; Requests[RequestCount].Owner:=sOwner;
  Requests[RequestCount].Life:=Life; Inc(RequestCount);
end;
procedure SimFXClear;
begin
  FillChar(Spark,SizeOf(Spark),0);SparkParts.Destroy;
  SparkParts.TimeStep:=1;SparkParts.GravityMultiplier:=1/1.4;SparkParts.EDamping:=0.998;
  RequestCount:=0;SparksCount:=0;LastTick:=-1;Replaying:=False;
end;
procedure SimFXReset(Seed: LongWord);
begin
  SimFXClear;ResetFXRandom(Seed);
end;
procedure SimFXReplay(Value: Boolean);
begin Replaying:=Value; end;
procedure SimFXSetView(X,Y,Width,Height: Single);
begin CameraX:=X; CameraY:=Y; ViewWidth:=Width; ViewHeight:=Height; end;
procedure TSpark.Update;
const
  NONEULER_STYLE = [12, 13, 14, 15, 17, 24, 25, 28, 29, 31, 36, 37, 50, 54, 56, 60];

  COLLIDABLE_STYLE = [2, 4, 5, 6, 7, 8, 9, 10, 11, 13, 16, 18, 19, 20, 21, 22,
    23, 30, 32, 33, 34, 40, 41, 42, 43, 48, 49, 51, 52, 57, 62, 64, 65, 66, 67,
    68, 69, 70, 71, 72, 73];
begin
  if not (Style in NONEULER_STYLE) then
    SparkParts.DoEulerTimeStepFor(Num);

  CheckOutOfBounds;

  // check collision with map
  if Style in COLLIDABLE_STYLE then
    CheckMapCollision(SparkParts.Pos[Num].X, SparkParts.Pos[Num].Y);

  // smoke luska
  if (r_maxsparks.Value > (MAX_SPARKS - 10)) and (Style > 64) and  (Life > 235) and
     (FXRandom(32) = 0) then
    CreateSpark(Sparkparts.Pos[Num], Sparkparts.Velocity[Num], 31, Owner, 40);

  // smoke m79 luska
  if (r_maxsparks.Value > (MAX_SPARKS - 10)) and (Style = 52) then
  begin
    if (Life > 235) and (FXRandom(6) = 0) then
      CreateSpark(Sparkparts.Pos[Num], Sparkparts.Velocity[Num], 31, Owner, 40);

    if (Life > 85) and (Life < 235) and (FXRandom(15) = 0) then
      CreateSpark(Sparkparts.Pos[Num], Sparkparts.Velocity[Num], 31, Owner, 35);

    if (Life < 85) and (FXRandom(24) = 0) then
      CreateSpark(Sparkparts.Pos[Num], Sparkparts.Velocity[Num], 31, Owner, 30);
  end;

  // iskry
  if (r_maxsparks.Value > (MAX_SPARKS - 10)) and (Style = 2) and (FXRandom(8) = 0) then
    CreateSpark(Sparkparts.Pos[Num], Vector2(0, 0), 26, Owner, 35);

  LifePrev := Life;
  Life := Life - 1;
  if Life = 0 then
    Kill;
end;

function TSpark.CheckMapCollision(X, Y: Single): Boolean;
var
  j, w: Integer;
  b: Integer = 0;
  Pos, Perp: TVector2;
  D: Single = 0.0;
  kx, ky: Integer;
  teamcol: Boolean;
begin
  Result := False;

  Pos.X := X - 8;
  Pos.Y := Y - 1;

  {iterate through maps sector polygons}
  kx := Round(Pos.X / Map.SectorsDivision);
  ky := Round(Pos.Y / Map.SectorsDivision);
  if (kx < -Map.SectorsNum) or (kx > Map.SectorsNum) or
    (ky < -Map.SectorsNum) or (ky > Map.SectorsNum) then
    Exit;

  if High(Map.Sectors[kx, ky].Polys) > 0 then
    for j := 1 to High(Map.Sectors[kx, ky].Polys) do
    begin
      w := Map.Sectors[kx, ky].Polys[j];

      if (Owner < 1) or (Owner > 32) then Exit;

      teamcol := TeamCollides(w, Sprite[Owner].Player.Team, False);

      if teamcol then
        if not ((Map.PolyType[w] = POLY_TYPE_BOUNCY) and (Sprite[Owner].HoldedThing = 0)) then
          if (Map.PolyType[w] <> POLY_TYPE_ONLY_BULLETS) and
            (Map.PolyType[w] <> POLY_TYPE_ONLY_PLAYER) and
            (Map.PolyType[w] <> POLY_TYPE_DOESNT) and
            (Map.PolyType[w] <> POLY_TYPE_BACKGROUND) and
            (Map.PolyType[w] <> POLY_TYPE_BACKGROUND_TRANSITION) then
            if Map.PointInPolyEdges(Pos.X, Pos.y, w) then
            begin
              Perp := Map.ClosestPerpendicular(w, Pos, D, b);

              Vec2Normalize(Perp, Perp);
              Vec2Scale(Perp, Perp, D);

              SparkParts.Velocity[Num] := Vec2Subtract(SparkParts.Velocity[Num], Perp);

              Vec2Scale(SparkParts.Velocity[Num], SparkParts.Velocity[Num], SPARK_SURFACECOEF);

              case Style of
                2, 62:
                  begin
                    Vec2Scale(Perp, Perp, 2.5);
                    Perp.X := Perp.X - 0.5 + FXRandom(11) / 10;
                    Perp.Y := -Perp.Y;
                    if FXRandom(2) = 0 then
                    begin
                      if FXRandom(2) = 0 then
                        CreateSpark(Pos, Perp, 26, Owner, 35) else
                        CreateSpark(Pos, Perp, 27, Owner, 35);

                      PlaySound(SFX_TS, SparkParts.Pos[Num]);
                    end;
                  end;
                33, 34:
                  begin
                    Vec2Scale(Perp, Perp, 2.5);
                    Perp.X := Perp.X - 0.5 + FXRandom(11) / 10;
                    Perp.Y := -Perp.Y;
                    if FXRandom(7) = 0 then
                      CreateSpark(Pos, Perp, 26, Owner, 35) else
                      CreateSpark(Pos, Perp, 27, Owner, 35);

                    if CollideCount > 4 then
                      Kill;
                  end;
                4, 5:
                  begin
                    if Style = 5 then
                      CreateSpark(Sparkparts.Pos[Num], Sparkparts.Velocity[Num], 55, Owner, 30);

                    if CollideCount > 1 then
                      Kill;
                  end;
                6:
                  begin
                    if (CollideCount = 0) or (CollideCount = 2) or (CollideCount = 4) then
                      PlaySound(SFX_CLIPFALL, SparkParts.Pos[Num]);

                    if CollideCount > 4 then
                      Kill;
                  end;
                7, 21, 22, 16, 30, 52, 65, 66, 67, 68, 69, 70, 71, 72, 73:
                  begin
                    if (CollideCount = 0) or (CollideCount = 2) or (CollideCount = 4) then
                      PlaySound(SFX_SHELL + FXRandom(2), SparkParts.Pos[Num]);
                    if CollideCount > 4 then Kill;
                  end;
                51:
                  begin
                    PlaySound(SFX_GAUGESHELL, SparkParts.Pos[Num]);
                    if CollideCount > 4 then Kill;
                  end;
                32, 48, 49:
                  begin
                    if CollideCount > 2 then
                      Kill;
                  end;
                9, 10, 11, 18, 19, 20, 23:
                  begin
                    if (CollideCount = 0) or (CollideCount = 4) then
                      PlaySound(SFX_CLIPFALL, SparkParts.Pos[Num]);

                    if CollideCount > 4 then Kill;
                  end;
                57:
                  begin
                    Vec2Scale(Perp, Perp, 0.75);
                    Perp.X := Perp.X - 0.5 + FXRandom(11) / 10;
                    Perp.Y := -Perp.Y;
                    if FXRandom(2) = 0 then
                      CreateSpark(Pos, Perp, 58, Owner, 50) else
                      CreateSpark(Pos, Perp, 58, Owner, 50);
                  end;
              end;

              Inc(CollideCount);

              Result := True;
              Exit;
            end;  // PointinPolyEdges
    end;  // for j
end;

procedure TSpark.Kill;
begin
  Active := False;
  Style := 0;
  if Num > 0 then
    SparkParts.Active[Num] := False;
end;

procedure TSpark.CheckOutOfBounds;
var
  Bound: Integer;
  SparkPartsPos: ^TVector2;
begin
  Bound := Map.SectorsNum * Map.SectorsDivision - 10;
  SparkPartsPos := @SparkParts.Pos[Num];

  if (Abs(SparkPartsPos.X) > Bound) or
     (Abs(SparkPartsPos.Y) > Bound) then
    Kill;
end;


procedure Weather;
var I,Style,Life: Integer; A,B:TVector2;
begin
  if not (Map.Weather in [1,2,3]) then Exit;
  PlaySound(SFX_WIND,CHANNEL_WEATHER);
  if MainTickCounter mod 17<>0 then Exit;
  A.X:=CameraX-ViewWidth/2-128;
  case Map.Weather of
    1: begin Style:=38; Life:=60; B:=Vector2(0,12); A.Y:=CameraY-ViewHeight/2-188; end;
    2: begin Style:=39; Life:=80; B:=Vector2(10,7); A.X:=CameraX-ViewWidth/2-768; A.Y:=CameraY-ViewHeight/2-316; end;
    else begin Style:=53; Life:=80; B:=Vector2(1,2); A.X:=CameraX-ViewWidth/2-256; A.Y:=CameraY-ViewHeight/2-60; end;
  end;
  for I:=1 to 8 do begin
    A.X:=A.X+78+FXRandom(90);
    case Map.Weather of
      1:A.Y:=CameraY-ViewHeight/2-188+FXRandom(150);
      2:A.Y:=CameraY-ViewHeight/2-316+FXRandom(150);
      3:A.Y:=CameraY-ViewHeight/2-60+FXRandom(150);
    end;
    Activate(A,B,Style,255,Life);
  end;
end;
function SimFXStep: LongInt;
var I: Integer;
begin
  if Replaying or (LastTick=MainTickCounter) then Exit(MainTickCounter);
  LastTick:=MainTickCounter; Updating:=True;
  try
    for I:=0 to RequestCount-1 do with Requests[I] do Activate(Position,Velocity,Style,Owner,Life);
    RequestCount:=0; SparksCount:=0;
    for I:=1 to MAX_SPARKS do if Spark[I].Active then begin Spark[I].Update; Inc(SparksCount); end;
    Weather;
  finally Updating:=False; end;
  Result:=LastTick;
end;
procedure U32(O:Integer;V:LongWord);
begin Move(V,View[O],4); end;
procedure F32(O:Integer;V:Single);
begin Move(V,View[O],4); end;
function SimFXRenderView: Pointer;
var I,N,O: Integer; L,SX,SY,R,A,DX,DY:Single; Tint:LongWord;
begin
  N:=0;
  for I:=1 to MAX_SPARKS do if Spark[I].Active then begin
    O:=32+N*FX_STRIDE; Inc(N); L:=Spark[I].Life;
    SX:=1;SY:=1;R:=0;Tint:=$FFFFFF;A:=255;DX:=0;DY:=0;
    case Spark[I].Style of
      1,31,32:A:=L+10;
      2:A:=L;
      3:A:=L*3+10;
      4:begin SX:=0.75;SY:=0.75;R:=DegToRad(L*10);A:=L*2+65;end;
      5:begin if L>10 then SX:=0.33+10/L;SY:=SX;R:=DegToRad(L*2);A:=L*2+85;end;
      6:begin R:=DegToRad(L*2);if Spark[I].Owner in [1..MAX_SPRITES] then Tint:=Sprite[Spark[I].Owner].Player.ShirtColor;end;
      7,30,33,34,65..70,72,73:R:=DegToRad(L*4);
      8:begin SX:=1.1;SY:=1.2;R:=DegToRad(L*3.5);Tint:=$FF3333;end;
      9..11,18..20,23:begin DX:=8;R:=Pi;end;
      12:begin DX:=-19;DY:=-38;SX:=0.75;SY:=SX;A:=255-EXPLOSION_ANIMS*5+L;end;
      13:begin DX:=-8;DY:=-17;SX:=0.3;SY:=SX;A:=255-2*L;end;
      14:begin DX:=-50;DY:=-100;SX:=2;SY:=2;A:=255-2*L;end;
      15:begin DX:=-75;DY:=-150;SX:=3;SY:=3;A:=255-2*L;end;
      16:begin SY:=2;R:=DegToRad(L*3.5);Tint:=$8877FF;end;
      17:begin DX:=-25;DY:=-50;A:=255-EXPLOSION_ANIMS*5+L;end;
      21:begin SX:=1.1;R:=DegToRad(L*3.77);end;
      22:begin SX:=1.3;R:=DegToRad(L*3.5);end;
      24:begin SX:=0.6+(75/L)/126;SY:=0.6+(75/L)/120;DX:=-22*SX;DY:=-64+L/2;A:=Trunc(3*L);end;
      25,61:begin DX:=-20;DY:=-20;R:=DegToRad(L);A:=6*L;
        if Spark[I].Style=61 then begin DX:=-10;DY:=-10;SX:=0.5;SY:=0.5;A:=14*L;end;
        if Spark[I].Owner in [1..MAX_SPRITES] then Tint:=Sprite[Spark[I].Owner].Player.ShirtColor;end;
      26,27:begin A:=L*3+154;if Spark[I].Style=26 then Tint:=$FFFE35 else Tint:=$AAAAAA;end;
      28:begin DX:=-15;DY:=-37;SX:=0.5;SY:=0.5;A:=255-2*L;end;
      29:begin SX:=0.5*(0.6+(75/L)/96);SY:=0.5*(0.6+(75/L)/90);DX:=-22*SX;DY:=-48+L/1.5;A:=Trunc(2.5*L);end;
      35:A:=L*13;
      36,37,64:begin SX:=L/35;if Spark[I].Style=37 then SX:=L/75;SY:=SX;DY:=-1/SY;
        if Spark[I].Style=37 then A:=L*3 else A:=L*2+185;end;
      38,39,53:A:=105;
      40..43:begin R:=DegToRad(L*8);A:=Trunc(L+10);end;
      44..47:begin SX:=0.7;SY:=0.7;A:=Trunc(L*2)+15;end;
      48,49:begin R:=DegToRad(L*5);A:=Trunc(L*2)+15;
        if Spark[I].Owner in [1..MAX_SPRITES] then
          if Spark[I].Style=48 then Tint:=Sprite[Spark[I].Owner].Player.ShirtColor else Tint:=Sprite[Spark[I].Owner].Player.PantsColor;end;
      50:A:=Trunc(L)+5;
      51,52:R:=DegToRad(L*3.77);
      54:begin DX:=-26;DY:=-48;Tint:=$DDDDDD;A:=L*3+10;end;
      55:begin if L>20 then SX:=0.63+10/L;SY:=SX;R:=DegToRad(L);A:=L*2+55;end;
      56:begin DX:=-3;DY:=-3;A:=Trunc(2.5*L);end;
      57,58:begin Tint:=$FFFF00;if Spark[I].Style=57 then A:=L*2+10 else A:=L*3+10;end;
      59:begin DY:=-(50-L);SX:=1.5+(620/L)/50;SY:=SX;A:=L*2;end;
      60:begin SX:=0.5+16/(L+50);SY:=SX;DX:=-14*SX;DY:=-30;A:=Trunc(L/3.3);end;
      62:begin R:=DegToRad(L);A:=L*5;if Spark[I].Owner in [1..MAX_SPRITES] then Tint:=Sprite[Spark[I].Owner].Player.JetColor;end;
      71:R:=DegToRad(L*3.5);
    end;
    if Spark[I].Style=33 then Tint:=$BBAAA9;
    U32(O,I);U32(O+4,Spark[I].Style);U32(O+8,Spark[I].Owner);U32(O+12,Spark[I].Life);
    F32(O+16,SparkParts.Pos[I].X);F32(O+20,SparkParts.Pos[I].Y);
    F32(O+24,SparkParts.OldPos[I].X);F32(O+28,SparkParts.OldPos[I].Y);
    U32(O+32,Spark[I].LifePrev);F32(O+36,SX);F32(O+40,SY);F32(O+44,R);
    U32(O+48,Tint);U32(O+52,Round(EnsureRange(A,0,255)));F32(O+56,DX);F32(O+60,DY);
  end;
  U32(0,SIM_ABI_VERSION);U32(4,MainTickCounter);U32(8,N);U32(12,MAX_SPARKS);
  U32(16,FX_STRIDE);U32(20,FX_BYTES);U32(24,Map.Weather);U32(28,0);
  Result:=@View[0];
end;
end.
