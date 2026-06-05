import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, ScrollView, SafeAreaView } from 'react-native';
import { WebView } from 'react-native-webview';

// Replace this with your Raspberry Pi 5's actual network IP address
const RASPI_IP = "192.168.100.137";
const WS_URL = `ws://${RASPI_IP}:8765`;
const SENSOR_API_URL = `http://${RASPI_IP}:5000/api/v1/sensors`;

const RECONNECT_DELAY_MS = 3000;

// ---------------------------------------------------------------------------
// The WebView runs this HTML page in an isolated browser context.
// It opens its OWN WebSocket to the Pi, receives binary frames, and draws
// them directly onto a <canvas> — no React re-render, no image unmount/remount,
// no flicker. It posts status messages back to React Native via postMessage.
// ---------------------------------------------------------------------------
const STREAM_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; background: #3A322D; overflow: hidden; }
  canvas { width: 100%; height: 100%; object-fit: cover; display: block; }
  #placeholder {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    color: #EED6B3; font-family: sans-serif; font-size: 16px;
  }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="placeholder">Connecting to Raspberry Pi...</div>
<script>
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const placeholder = document.getElementById('placeholder');
  const WS_URL = '${WS_URL}';
  const RECONNECT_DELAY_MS = ${RECONNECT_DELAY_MS};

  function postStatus(connected) {
    window.ReactNativeWebView.postMessage(connected ? 'connected' : 'disconnected');
  }

  function connect() {
    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      postStatus(true);
      placeholder.style.display = 'none';
    };

    ws.onmessage = (event) => {
      // Convert the raw binary frame into a Blob URL, draw it on canvas,
      // then immediately revoke the URL — no DOM image nodes accumulate.
      const blob = new Blob([event.data], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        // Size canvas to match the frame exactly (once, on first frame)
        if (canvas.width !== img.naturalWidth) {
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
        }
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
      };
      img.src = url;
    };

    ws.onerror = () => postStatus(false);

    ws.onclose = () => {
      postStatus(false);
      placeholder.textContent = 'Reconnecting...';
      placeholder.style.display = 'flex';
      setTimeout(connect, RECONNECT_DELAY_MS);
    };
  }

  connect();
</script>
</body>
</html>`;

export default function CrayfishStreamDashboard() {
  const [stats, setStats] = useState({ temp: '--', ph: '--', filterStatus: 'Good' });
  const [isConnected, setIsConnected] = useState(false);

  // Receive connection status messages back from the WebView
  const handleWebViewMessage = (event: any) => {
    setIsConnected(event.nativeEvent.data === 'connected');
  };

  // Poll Environment Metrics from HTTP API
  useEffect(() => {
    const fetchStats = () => {
      fetch(SENSOR_API_URL)
        .then(res => res.json())
        .then(data => setStats(data))
        .catch(err => {
          console.error("Error fetching sensor data from Pi:", err);
          setStats({ temp: 'Offline', ph: 'Offline', filterStatus: 'Offline' });
        });
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.scrollContainer}>

        {/* Header Banner */}
        <View style={styles.header}>
          <View style={styles.logoRow}>
            <Text style={styles.logo}>🦞 ClawCam</Text>
            <View style={[styles.badge, isConnected ? styles.liveBadge : styles.offlineBadge]}>
              <Text style={styles.badgeText}>{isConnected ? 'LIVE' : 'OFFLINE'}</Text>
            </View>
          </View>
          <Text style={styles.tagline}>Real-time viewing of the crayfish habitat</Text>
        </View>

        {/* Video Player — WebView draws frames onto a canvas, no flicker */}
        <View style={styles.videoWrapper}>
          <WebView
            style={styles.webview}
            source={{ html: STREAM_HTML }}
            onMessage={handleWebViewMessage}
            // Required for WebSockets and Blob URLs to work inside the WebView
            originWhitelist={['*']}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            // Transparent background so the dark videoWrapper shows through
            // before the first frame arrives
            backgroundColor="transparent"
          />
        </View>

        {/* Environmental Telemetry Metrics */}
        <View style={styles.statsCard}>
          <Text style={styles.statsTitle}>Tank Environment</Text>
          <Text style={styles.statsSubtitle}>Telemetry powered by Raspberry Pi 5</Text>

          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Water Temperature</Text>
            <Text style={styles.statValue}>{stats.temp}°C</Text>
          </View>

          <View style={styles.statBox}>
            <Text style={styles.statLabel}>pH Balance</Text>
            <Text style={styles.statValue}>{stats.ph}</Text>
          </View>

          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Filtration System</Text>
            <Text style={[styles.statValue, { color: '#4A7A56' }]}>
              {stats.filterStatus}
            </Text>
          </View>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#FAF6F0',
  },
  scrollContainer: {
    padding: 24,
  },
  header: {
    borderBottomWidth: 2,
    borderBottomColor: '#EED6B3',
    paddingBottom: 20,
    marginBottom: 24,
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  logo: {
    color: '#D35230',
    fontSize: 28,
    fontWeight: 'bold',
    marginRight: 10,
  },
  badge: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  liveBadge: {
    backgroundColor: '#D35230',
  },
  offlineBadge: {
    backgroundColor: '#7A6E67',
  },
  badgeText: {
    color: '#FFF',
    fontSize: 12,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  tagline: {
    color: '#6E6259',
    fontSize: 14,
  },
  videoWrapper: {
    backgroundColor: '#3A322D',
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#EED6B3',
    aspectRatio: 16 / 9,
    marginBottom: 24,
    shadowColor: '#3A322D',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 3,
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  statsCard: {
    backgroundColor: '#FFF',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#EED6B3',
    marginBottom: 20,
  },
  statsTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#3A322D',
    marginBottom: 2,
  },
  statsSubtitle: {
    fontSize: 13,
    color: '#8E8073',
    marginBottom: 16,
  },
  statBox: {
    backgroundColor: '#FFF9F2',
    padding: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#F3E4D0',
    marginBottom: 12,
  },
  statLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6E6259',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#D35230',
  }
});