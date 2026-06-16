import React, { useEffect, useRef, useState } from "react";

const SH_C0 = 0.28209479177387814;
const DEFAULT_VIEW = {
  yaw: 0.55,
  pitch: -0.24,
  distance: 3.4,
  panX: 0,
  panY: 0,
};

const TYPE_SIZES = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatCount(value) {
  return new Intl.NumberFormat().format(value);
}

function findHeader(array) {
  const marker = new TextEncoder().encode("end_header");
  for (let i = 0; i <= array.length - marker.length; i += 1) {
    let matched = true;
    for (let j = 0; j < marker.length; j += 1) {
      if (array[i + j] !== marker[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      let dataOffset = i + marker.length;
      while (array[dataOffset] === 10 || array[dataOffset] === 13) dataOffset += 1;
      return {
        text: new TextDecoder("ascii").decode(array.slice(0, i + marker.length)),
        dataOffset,
      };
    }
  }
  throw new Error("This does not look like a PLY file");
}

function parseHeader(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  let format = "";
  let vertexCount = 0;
  let readingVertexProperties = false;
  const properties = [];

  for (const line of lines) {
    if (!line || line.startsWith("comment ")) continue;

    const parts = line.split(/\s+/);
    if (parts[0] === "format") {
      format = parts[1];
      continue;
    }

    if (parts[0] === "element") {
      readingVertexProperties = parts[1] === "vertex";
      if (readingVertexProperties) vertexCount = Number(parts[2]);
      continue;
    }

    if (readingVertexProperties && parts[0] === "property") {
      if (parts[1] === "list") {
        throw new Error("List properties are not supported in the browser viewer yet");
      }
      properties.push({ type: parts[1], name: parts[2] });
    }
  }

  if (!vertexCount || !properties.length) {
    throw new Error("PLY file is missing vertex data");
  }

  return { format, vertexCount, properties };
}

function readValue(view, offset, type, littleEndian = true) {
  switch (type) {
    case "char":
    case "int8":
      return view.getInt8(offset);
    case "uchar":
    case "uint8":
      return view.getUint8(offset);
    case "short":
    case "int16":
      return view.getInt16(offset, littleEndian);
    case "ushort":
    case "uint16":
      return view.getUint16(offset, littleEndian);
    case "int":
    case "int32":
      return view.getInt32(offset, littleEndian);
    case "uint":
    case "uint32":
      return view.getUint32(offset, littleEndian);
    case "float":
    case "float32":
      return view.getFloat32(offset, littleEndian);
    case "double":
    case "float64":
      return view.getFloat64(offset, littleEndian);
    default:
      throw new Error(`Unsupported PLY property type: ${type}`);
  }
}

function getColor(values) {
  if (values.f_dc_0 != null && values.f_dc_1 != null && values.f_dc_2 != null) {
    return [
      clamp(0.5 + SH_C0 * values.f_dc_0, 0, 1),
      clamp(0.5 + SH_C0 * values.f_dc_1, 0, 1),
      clamp(0.5 + SH_C0 * values.f_dc_2, 0, 1),
    ];
  }

  if (values.red != null && values.green != null && values.blue != null) {
    return [
      clamp(values.red / 255, 0, 1),
      clamp(values.green / 255, 0, 1),
      clamp(values.blue / 255, 0, 1),
    ];
  }

  return [0.94, 0.78, 0.62];
}

function normalizePositions(rawPositions, colors, vertexCount) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < rawPositions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = rawPositions[i + axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }

  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const largestAxis = Math.max(size[0], size[1], size[2], 0.0001);
  const center = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const scale = 2.15 / largestAxis;
  const positions = new Float32Array(rawPositions.length);

  for (let i = 0; i < rawPositions.length; i += 3) {
    positions[i] = (rawPositions[i] - center[0]) * scale;
    positions[i + 1] = (rawPositions[i + 1] - center[1]) * scale;
    positions[i + 2] = (rawPositions[i + 2] - center[2]) * scale;
  }

  return {
    positions,
    colors,
    vertexCount,
    bounds: { width: size[0], height: size[1], depth: size[2] },
  };
}

function parseBinaryPly(buffer, dataOffset, vertexCount, properties, littleEndian) {
  const view = new DataView(buffer);
  let stride = 0;
  const layout = properties.map((property) => {
    const size = TYPE_SIZES[property.type];
    if (!size) throw new Error(`Unsupported PLY property type: ${property.type}`);
    const entry = { ...property, offset: stride, size };
    stride += size;
    return entry;
  });

  if (dataOffset + stride * vertexCount > buffer.byteLength) {
    throw new Error("PLY file ended before all vertices could be read");
  }

  const rawPositions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const base = dataOffset + vertex * stride;
    const values = {};
    for (const property of layout) {
      values[property.name] = readValue(
        view,
        base + property.offset,
        property.type,
        littleEndian,
      );
    }

    const pointIndex = vertex * 3;
    rawPositions[pointIndex] = values.x ?? 0;
    rawPositions[pointIndex + 1] = values.y ?? 0;
    rawPositions[pointIndex + 2] = values.z ?? 0;

    const color = getColor(values);
    colors[pointIndex] = color[0];
    colors[pointIndex + 1] = color[1];
    colors[pointIndex + 2] = color[2];
  }

  return normalizePositions(rawPositions, colors, vertexCount);
}

function parseAsciiPly(bytes, dataOffset, vertexCount, properties) {
  const body = new TextDecoder("ascii").decode(bytes.slice(dataOffset));
  const lines = body.split(/\r?\n/).filter(Boolean);
  const rawPositions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const parts = lines[vertex].trim().split(/\s+/).map(Number);
    const values = {};
    properties.forEach((property, index) => {
      values[property.name] = parts[index];
    });

    const pointIndex = vertex * 3;
    rawPositions[pointIndex] = values.x ?? 0;
    rawPositions[pointIndex + 1] = values.y ?? 0;
    rawPositions[pointIndex + 2] = values.z ?? 0;

    const color = getColor(values);
    colors[pointIndex] = color[0];
    colors[pointIndex + 1] = color[1];
    colors[pointIndex + 2] = color[2];
  }

  return normalizePositions(rawPositions, colors, vertexCount);
}

function parsePly(buffer) {
  const bytes = new Uint8Array(buffer);
  const { text, dataOffset } = findHeader(bytes);
  const { format, vertexCount, properties } = parseHeader(text);

  if (format === "binary_little_endian") {
    return parseBinaryPly(buffer, dataOffset, vertexCount, properties, true);
  }

  if (format === "binary_big_endian") {
    return parseBinaryPly(buffer, dataOffset, vertexCount, properties, false);
  }

  if (format === "ascii") {
    return parseAsciiPly(bytes, dataOffset, vertexCount, properties);
  }

  throw new Error(`Unsupported PLY format: ${format || "unknown"}`);
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message || "Could not compile WebGL shader");
  }

  return shader;
}

function createProgram(gl) {
  const vertexShader = compileShader(
    gl,
    gl.VERTEX_SHADER,
    `
      attribute vec3 a_position;
      attribute vec3 a_color;

      uniform vec2 u_rotation;
      uniform vec2 u_pan;
      uniform float u_distance;
      uniform float u_aspect;
      uniform float u_pointSize;

      varying vec3 v_color;

      void main() {
        vec3 point = a_position;

        float yawCos = cos(u_rotation.x);
        float yawSin = sin(u_rotation.x);
        point = vec3(
          yawCos * point.x + yawSin * point.z,
          point.y,
          -yawSin * point.x + yawCos * point.z
        );

        float pitchCos = cos(u_rotation.y);
        float pitchSin = sin(u_rotation.y);
        point = vec3(
          point.x,
          pitchCos * point.y - pitchSin * point.z,
          pitchSin * point.y + pitchCos * point.z
        );

        point.xy += u_pan;
        point.z -= u_distance;

        float fov = 1.7320508;
        float near = 0.01;
        float far = 100.0;
        float clipZ = ((far + near) / (near - far)) * point.z
          + (2.0 * far * near) / (near - far);

        gl_Position = vec4(
          point.x * fov / u_aspect,
          point.y * fov,
          clipZ,
          -point.z
        );
        gl_PointSize = clamp(u_pointSize * (3.6 / max(1.0, -point.z)), 1.3, 9.0);
        v_color = a_color;
      }
    `,
  );

  const fragmentShader = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    `
      precision mediump float;

      varying vec3 v_color;

      void main() {
        vec2 offset = gl_PointCoord - vec2(0.5);
        float radius = dot(offset, offset);
        if (radius > 0.25) discard;

        float alpha = 1.0 - smoothstep(0.14, 0.25, radius);
        gl_FragColor = vec4(v_color, alpha);
      }
    `,
  );

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(message || "Could not link WebGL program");
  }

  return program;
}

function createRenderer(canvas, pointCloud) {
  const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
  if (!gl) throw new Error("WebGL is not available in this browser");

  const program = createProgram(gl);
  const positionBuffer = gl.createBuffer();
  const colorBuffer = gl.createBuffer();
  const locations = {
    position: gl.getAttribLocation(program, "a_position"),
    color: gl.getAttribLocation(program, "a_color"),
    rotation: gl.getUniformLocation(program, "u_rotation"),
    pan: gl.getUniformLocation(program, "u_pan"),
    distance: gl.getUniformLocation(program, "u_distance"),
    aspect: gl.getUniformLocation(program, "u_aspect"),
    pointSize: gl.getUniformLocation(program, "u_pointSize"),
  };

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, pointCloud.positions, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, pointCloud.colors, gl.STATIC_DRAW);

  function draw(view) {
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(canvas.clientWidth * pixelRatio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * pixelRatio));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    gl.viewport(0, 0, width, height);
    gl.clearColor(0.055, 0.045, 0.038, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(locations.position);
    gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.enableVertexAttribArray(locations.color);
    gl.vertexAttribPointer(locations.color, 3, gl.FLOAT, false, 0, 0);

    gl.uniform2f(locations.rotation, view.yaw, view.pitch);
    gl.uniform2f(locations.pan, view.panX, view.panY);
    gl.uniform1f(locations.distance, view.distance);
    gl.uniform1f(locations.aspect, width / height);
    gl.uniform1f(locations.pointSize, Math.min(7, Math.max(3.5, 14000 / pointCloud.vertexCount)));

    gl.drawArrays(gl.POINTS, 0, pointCloud.vertexCount);
  }

  function dispose() {
    gl.deleteBuffer(positionBuffer);
    gl.deleteBuffer(colorBuffer);
    gl.deleteProgram(program);
  }

  return { draw, dispose };
}

export default function PlyViewer({ src }) {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const dragRef = useRef(null);
  const [pointCloud, setPointCloud] = useState(null);
  const [view, setView] = useState(DEFAULT_VIEW);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function load() {
      setStatus("loading");
      setError("");
      setPointCloud(null);
      setView(DEFAULT_VIEW);

      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.detail || "Could not load the PLY file");
        }

        const cloud = parsePly(await response.arrayBuffer());
        if (!cancelled) {
          setPointCloud(cloud);
          setStatus("ready");
        }
      } catch (loadError) {
        if (!cancelled && loadError.name !== "AbortError") {
          setStatus("failed");
          setError(loadError.message);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [src]);

  useEffect(() => {
    if (!canvasRef.current || !pointCloud) return undefined;

    let renderer;
    try {
      renderer = createRenderer(canvasRef.current, pointCloud);
      rendererRef.current = renderer;
      renderer.draw(view);
    } catch (rendererError) {
      setStatus("failed");
      setError(rendererError.message);
      return undefined;
    }

    const resizeObserver = new ResizeObserver(() => renderer.draw(view));
    resizeObserver.observe(canvasRef.current);

    return () => {
      resizeObserver.disconnect();
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [pointCloud]);

  useEffect(() => {
    rendererRef.current?.draw(view);
  }, [view]);

  function startDrag(event) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      mode: event.shiftKey || event.altKey ? "pan" : "rotate",
      view,
    };
  }

  function moveDrag(event) {
    if (!dragRef.current) return;
    const drag = dragRef.current;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;

    if (drag.mode === "pan") {
      const panSpeed = 0.0027 * drag.view.distance;
      setView({
        ...drag.view,
        panX: drag.view.panX + dx * panSpeed,
        panY: drag.view.panY - dy * panSpeed,
      });
      return;
    }

    setView({
      ...drag.view,
      yaw: drag.view.yaw + dx * 0.008,
      pitch: clamp(drag.view.pitch + dy * 0.008, -1.45, 1.45),
    });
  }

  function endDrag(event) {
    if (dragRef.current) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
  }

  function zoom(event) {
    event.preventDefault();
    setView((current) => ({
      ...current,
      distance: clamp(current.distance * Math.exp(event.deltaY * 0.001), 1.15, 14),
    }));
  }

  return (
    <div className="viewer-card">
      <div
        className="viewer-canvas-wrap"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={zoom}
        onDoubleClick={() => setView(DEFAULT_VIEW)}
      >
        <canvas ref={canvasRef} aria-label="3D PLY viewer" />
        {status !== "ready" && (
          <div className="viewer-overlay">
            {status === "loading" ? "Loading 3D viewer..." : error}
          </div>
        )}
      </div>

      <div className="viewer-toolbar">
        <div>
          <p className="eyebrow">BROWSER VIEW</p>
          <p className="viewer-meta">
            {pointCloud
              ? `${formatCount(pointCloud.vertexCount)} points loaded`
              : "Preparing point cloud"}
          </p>
        </div>
        <button type="button" className="ghost-button" onClick={() => setView(DEFAULT_VIEW)}>
          Reset view
        </button>
      </div>

      <p className="viewer-help">Drag to orbit. Scroll to zoom. Shift + drag to pan.</p>
    </div>
  );
}
