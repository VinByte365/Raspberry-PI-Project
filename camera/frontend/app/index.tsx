import { Ionicons } from '@expo/vector-icons';
import * as ScreenOrientation from 'expo-screen-orientation';
// WebSocket bridge URL for sensor data (bridge subscribes to MQTT on the Pi)
const SENSOR_WS_URL = `ws://${RASPI_IP}:8767`;
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

// Replace this with your Raspberry Pi 5's actual network IP address.
const RASPI_IP = '192.168.137.1';
const WS_URL = `ws://${RASPI_IP}:8766`;
const MQTT_WS_URL = `ws://${RASPI_IP}:9001`;

const RECONNECT_DELAY_MS = 3000;

type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';
type FitMode = 'fill' | 'fit';

type SensorState = {
  turbidity: string;
  tds: string;
  ph: string;
  mq135: string;
  tof: string;
};

const MQTT_TOPICS = [
  'sensors/water/turbidity',
  'sensors/water/tds',
  'sensors/water/ph',
  'sensors/air/ppm',
  'sensors/water/distance',
];

const STREAM_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%;
    height: 100%;
    background: #06090d;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
    background: #06090d;
  }
  #placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #d8e2ee;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 15px;
    letter-spacing: 0;
  }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="placeholder">Connecting to camera...</div>
<script>
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const placeholder = document.getElementById('placeholder');
  const WS_URL = '${WS_URL}';
  const RECONNECT_DELAY_MS = ${RECONNECT_DELAY_MS};

  let fitMode = 'fill';
  let isPaused = false;
  let lastImage = null;
  let frameCount = 0;

  function post(payload) {
    window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }

  function setPlaceholder(text, visible) {
    placeholder.textContent = text;
    placeholder.style.display = visible ? 'flex' : 'none';
  }

  function sizeCanvas() {
    const scale = window.devicePixelRatio || 1;
    const nextWidth = Math.max(1, Math.floor(canvas.clientWidth * scale));
    const nextHeight = Math.max(1, Math.floor(canvas.clientHeight * scale));

    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      drawLastFrame();
    }
  }

  function drawFrame(img) {
    sizeCanvas();

    const canvasRatio = canvas.width / canvas.height;
    const imageRatio = img.naturalWidth / img.naturalHeight;
    let drawWidth = canvas.width;
    let drawHeight = canvas.height;

    if (fitMode === 'fit') {
      if (imageRatio > canvasRatio) {
        drawHeight = canvas.width / imageRatio;
      } else {
        drawWidth = canvas.height * imageRatio;
      }
    } else if (imageRatio > canvasRatio) {
      drawWidth = canvas.height * imageRatio;
    } else {
      drawHeight = canvas.width / imageRatio;
    }

    const x = (canvas.width - drawWidth) / 2;
    const y = (canvas.height - drawHeight) / 2;

    ctx.fillStyle = '#06090d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, x, y, drawWidth, drawHeight);
  }

  function drawLastFrame() {
    if (lastImage) {
      drawFrame(lastImage);
    }
  }

  function applyCommand(command) {
    if (command.type === 'fitMode') {
      fitMode = command.value === 'fit' ? 'fit' : 'fill';
      drawLastFrame();
    }

    if (command.type === 'pause') {
      isPaused = Boolean(command.value);
      post({ type: 'paused', value: isPaused });
    }
  }

  window.cameraControls = { applyCommand };
  window.addEventListener('resize', sizeCanvas);

  function connect() {
    post({ type: 'status', value: 'connecting' });
    setPlaceholder('Connecting to camera...', true);

    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      post({ type: 'status', value: 'live' });
      setPlaceholder('', false);
    };

    ws.onmessage = (event) => {
      if (isPaused) {
        return;
      }

      const blob = new Blob([event.data], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const img = new Image();

      img.onload = () => {
        lastImage = img;
        frameCount += 1;
        drawFrame(img);
        post({ type: 'frame', value: frameCount });
        URL.revokeObjectURL(url);
      };

      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    };

    ws.onerror = () => {
      post({ type: 'status', value: 'offline' });
    };

    ws.onclose = () => {
      post({ type: 'status', value: 'reconnecting' });
      setPlaceholder('Reconnecting...', true);
      setTimeout(connect, RECONNECT_DELAY_MS);
    };
  }

  sizeCanvas();
  connect();
</script>
</body>
</html>`;

const statusCopy: Record<ConnectionState, string> = {
  connecting: 'CONNECTING',
  live: 'LIVE',
  reconnecting: 'RECONNECTING',
  offline: 'OFFLINE',
};

const statusIcon: Record<ConnectionState, keyof typeof Ionicons.glyphMap> = {
  connecting: 'sync',
  live: 'radio',
  reconnecting: 'refresh',
  offline: 'alert-circle',
};

export default function CrayfishStreamDashboard() {
  const webViewRef = useRef<WebView>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('connecting');
  const [fitMode, setFitMode] = useState<FitMode>('fill');
  const [isPaused, setIsPaused] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const [mqttConnected, setMqttConnected] = useState(false);
  const [sensorState, setSensorState] = useState<SensorState>({
    turbidity: '—',
    tds: '—',
    ph: '—',
    mq135: '—',
    tof: '—',
  });

  const sendWebViewCommand = useCallback((command: object) => {
    const script = `
      window.cameraControls?.applyCommand(${JSON.stringify(command)});
      true;
    `;
    webViewRef.current?.injectJavaScript(script);
  }, []);

  const toggleFitMode = useCallback(() => {
    setFitMode((currentMode) => {
      const nextMode = currentMode === 'fill' ? 'fit' : 'fill';
      sendWebViewCommand({ type: 'fitMode', value: nextMode });
      return nextMode;
    });
  }, [sendWebViewCommand]);

  const togglePause = useCallback(() => {
    setIsPaused((currentValue) => {
      const nextValue = !currentValue;
      sendWebViewCommand({ type: 'pause', value: nextValue });
      return nextValue;
    });
  }, [sendWebViewCommand]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(SENSOR_WS_URL);
    } catch (e) {
      console.warn('[SENSOR WS] Failed to create WebSocket', e);
      return;
    }

    ws.onopen = () => {
      setMqttConnected(true);
      console.log('[SENSOR WS] Connected');
    };

    ws.onclose = () => {
      setMqttConnected(false);
      console.log('[SENSOR WS] Closed');
    };

    ws.onerror = (err) => {
      setMqttConnected(false);
      console.warn('[SENSOR WS] Error', err);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const topic = msg.topic as string;
        const payload = String(msg.payload);

        setSensorState((current) => {
          switch (topic) {
            case 'sensors/water/turbidity':
              return { ...current, turbidity: payload };
            case 'sensors/water/tds':
              return { ...current, tds: payload };
            case 'sensors/water/ph':
              return { ...current, ph: payload };
            case 'sensors/air/ppm':
              return { ...current, mq135: payload };
            case 'sensors/water/distance':
              return { ...current, tof: payload };
            default:
              return current;
          }
        });
      } catch (err) {
        console.warn('[SENSOR WS] Bad message', err, ev.data);
      }
    };

    return () => {
      if (ws) ws.close();
    };
  }, []);

  const enterFullscreen = useCallback(async () => {
    setIsFullscreen(true);
    await ScreenOrientation.lockAsync(
      ScreenOrientation.OrientationLock.LANDSCAPE,
    );
  }, []);

  const exitFullscreen = useCallback(async () => {
    setIsFullscreen(false);
    await ScreenOrientation.lockAsync(
      ScreenOrientation.OrientationLock.PORTRAIT_UP,
    );
  }, []);

  useEffect(() => {
    return () => {
      ScreenOrientation.lockAsync(
        ScreenOrientation.OrientationLock.PORTRAIT_UP,
      ).catch(() => undefined);
    };
  }, []);

  const handleWebViewMessage = (event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);

      if (message.type === 'status') {
        setConnectionState(message.value);
      }

      if (message.type === 'frame') {
        setFrameCount(message.value);
      }
    } catch {
      setConnectionState(
        event.nativeEvent.data === 'connected' ? 'live' : 'offline',
      );
    }
  };

  const video = (
    <WebView
      ref={webViewRef}
      style={styles.webview}
      source={{ html: STREAM_HTML }}
      onMessage={handleWebViewMessage}
      originWhitelist={['*']}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
    />
  );

  const statusPill = (
    <View
      style={[
        styles.statusPill,
        connectionState === 'live' ? styles.livePill : styles.offlinePill,
      ]}
    >
      <Ionicons
        name={statusIcon[connectionState]}
        size={14}
        color={connectionState === 'live' ? '#9ff7c2' : '#f8c6bd'}
      />
      <Text style={styles.statusText}>{statusCopy[connectionState]}</Text>
    </View>
  );

  const controls = (
    <View style={styles.controls}>
      <IconButton
        icon={fitMode === 'fill' ? 'expand' : 'contract'}
        label={fitMode === 'fill' ? 'Fill' : 'Fit'}
        onPress={toggleFitMode}
      />
      <IconButton
        icon={isPaused ? 'play' : 'pause'}
        label={isPaused ? 'Resume' : 'Pause'}
        onPress={togglePause}
      />
      <IconButton
        icon={isFullscreen ? 'contract' : 'scan'}
        label={isFullscreen ? 'Exit' : 'Full'}
        onPress={isFullscreen ? exitFullscreen : enterFullscreen}
      />
    </View>
  );

  if (isFullscreen) {
    return (
      <View style={styles.fullscreenPage}>
        <View style={styles.fullscreenVideo}>{video}</View>
        <View style={styles.fullscreenOverlay}>
          {statusPill}
          {controls}
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.header}>
        <View>
          <Text style={styles.logo}>ClawCam</Text>
          <Text style={styles.tagline}>Raspberry Pi live camera feed</Text>
        </View>
        {statusPill}
      </View>

      <View style={styles.videoWrapper}>{video}</View>

      <View style={styles.sensorPanel}>
        <View style={styles.sensorHeader}>
          <Text style={styles.panelTitle}>ESP32 Sensor Readings</Text>
          <Text style={styles.panelMeta}>
            MQTT {mqttConnected ? 'CONNECTED' : 'DISCONNECTED'}
          </Text>
        </View>

        <View style={styles.sensorGrid}>
          <SensorStat label="Turbidity" value={sensorState.turbidity} unit="ADC" />
          <SensorStat label="TDS" value={sensorState.tds} unit="ppm" />
          <SensorStat label="pH" value={sensorState.ph} unit="" />
          <SensorStat label="MQ135" value={sensorState.mq135} unit="ppm" />
          <SensorStat label="TOF" value={sensorState.tof} unit="mm" />
        </View>
      </View>

      <View style={styles.panel}>
        <View>
          <Text style={styles.panelTitle}>Camera</Text>
          <Text style={styles.panelMeta}>
            {isPaused ? 'Rendering paused' : `${frameCount} frames received`}
          </Text>
        </View>
        {controls}
      </View>
    </SafeAreaView>
  );
}

type IconButtonProps = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
};

function SensorStat({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <View style={styles.sensorStat}>
      <Text style={styles.sensorLabel}>{label}</Text>
      <Text style={styles.sensorValue}>{value}</Text>
      {unit ? <Text style={styles.sensorUnit}>{unit}</Text> : null}
    </View>
  );
}

function IconButton({ icon, label, onPress }: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        pressed && styles.iconButtonPressed,
      ]}
    >
      <Ionicons name={icon} size={20} color="#e8f1fb" />
      <Text style={styles.iconButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#10151b',
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 20,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  logo: {
    color: '#f2f7fb',
    fontSize: 27,
    fontWeight: '800',
  },
  tagline: {
    color: '#98a8b8',
    fontSize: 13,
    marginTop: 3,
  },
  statusPill: {
    alignItems: 'center',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 6,
    minHeight: 32,
    paddingHorizontal: 10,
  },
  livePill: {
    backgroundColor: '#123824',
    borderColor: '#26764c',
    borderWidth: 1,
  },
  offlinePill: {
    backgroundColor: '#3b201e',
    borderColor: '#814139',
    borderWidth: 1,
  },
  statusText: {
    color: '#f3f8fc',
    fontSize: 11,
    fontWeight: '800',
  },
  videoWrapper: {
    aspectRatio: 16 / 9,
    backgroundColor: '#06090d',
    borderColor: '#263442',
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  sensorPanel: {
    backgroundColor: '#18212a',
    borderColor: '#263442',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 14,
    padding: 14,
  },
  sensorHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sensorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between',
  },
  sensorStat: {
    backgroundColor: '#0f1b24',
    borderColor: '#1f3748',
    borderRadius: 10,
    borderWidth: 1,
    minWidth: '48%',
    padding: 12,
  },
  sensorLabel: {
    color: '#8ea0b2',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
  },
  sensorValue: {
    color: '#f6fbff',
    fontSize: 20,
    fontWeight: '800',
  },
  sensorUnit: {
    color: '#6da3c7',
    fontSize: 12,
    marginTop: 4,
  },
  panel: {
    alignItems: 'center',
    backgroundColor: '#18212a',
    borderColor: '#263442',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
    padding: 12,
  },
  panelTitle: {
    color: '#f2f7fb',
    fontSize: 15,
    fontWeight: '800',
  },
  panelMeta: {
    color: '#8ea0b2',
    fontSize: 12,
    marginTop: 3,
  },
  controls: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: '#243342',
    borderColor: '#33495c',
    borderRadius: 8,
    borderWidth: 1,
    height: 54,
    justifyContent: 'center',
    minWidth: 58,
    paddingHorizontal: 9,
  },
  iconButtonPressed: {
    backgroundColor: '#2f4558',
  },
  iconButtonText: {
    color: '#d8e2ee',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 3,
  },
  fullscreenPage: {
    backgroundColor: '#020406',
    flex: 1,
  },
  fullscreenVideo: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  fullscreenOverlay: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 16,
    position: 'absolute',
    right: 16,
    top: 16,
  },
});
