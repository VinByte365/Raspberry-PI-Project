#!/bin/bash
# Installation script for sensor dashboard on Linux/Raspberry Pi

echo "🚀 Installing Sensor Dashboard..."
echo "=================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm not found. Please install Node.js"
    exit 1
fi

echo "✅ Node.js $(node --version)"
echo "✅ npm $(npm --version)"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
cd "$(dirname "$0")"
npm install

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo ""
    echo "⚙️  Creating .env file..."
    cp .env.example .env
    echo "⚠️  Please edit .env with your configuration!"
fi

# Install systemd service (optional)
echo ""
echo "🔧 Service Installation (Optional)"
echo "To run as a system service:"
echo ""
echo "  sudo cp sensor-dashboard.service /etc/systemd/system/"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable sensor-dashboard"
echo "  sudo systemctl start sensor-dashboard"
echo ""
echo "Check status:"
echo "  sudo systemctl status sensor-dashboard"
echo ""

echo "✅ Installation complete!"
echo ""
echo "🚀 To start the server:"
echo "  npm start"
echo ""
echo "📊 Access dashboard at:"
echo "  http://localhost:8080"
