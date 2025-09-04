# Chrome Extension - AI-Powered Audio Capture

A Chrome extension that captures audio from browser tabs and integrates with Cloudflare Workers for AI processing. Built with Manifest V3, advanced Chrome APIs, and reliable background processing.

---

## 🎯 Core Functionality

### 🎤 Audio Capture
- **Tab Audio Recording:** Capture audio from any active browser tab  
- **Background Processing:** Continue recording when popup is closed  
- **8-minute Recording Limit:** Optimized for course segments and presentations  
- **Multiple Format Support:** WAV encoding with automatic compression  

### 🔄 Reliable Upload System
- **Chunked Transfer:** Break large recordings into 150KB segments  
- **Background Upload:** Persistent upload even after extension closes  
- **Retry Mechanism:** Automatic retry with exponential backoff  

---

## 🏗️ Technical Architecture

### Chrome APIs Used
- `chrome.tabCapture` – Audio recording from browser tabs  
- `chrome.offscreen` – Background audio processing  
- `chrome.runtime.connect` – Persistent port communication  
- `chrome.storage.local` – State persistence and recovery  

### Extension Components
- **Background Service Worker:** Coordinates recording and upload  
- **Offscreen Document:** Handles audio capture and encoding  
- **Popup Interface:** User controls and status display  
- **Content Scripts:** Tab integration and UI  

### Build System
- **Webpack:** Module bundling and optimization  
- **Babel:** Modern JavaScript compilation  
- **Manifest V3:** Latest Chrome extension format  
- **NPM Scripts:** Development and production builds  

---

## 🚀 Key Features

### Reliable Data Transfer
- **Port-based Communication:** Stable connection between components  
- **Chunk Acknowledgment:** Ensure complete data transfer  
- **Error Recovery:** Handle network interruptions gracefully  
- **Background Persistence:** Continue operations without user interaction  

### User Experience
- **One-click Recording:** Simple start/stop interface  
- **Visual Feedback:** Recording status and progress indicators  
- **Focus Mode:** Background recording persistence  
- **Error Notifications:** Clear user feedback for issues  

---

## 🛠️ Configuration

### Extension Permissions
- `tabCapture` – Record audio from browser tabs  
- `offscreen` – Background audio processing  
- `storage` – Save recording state and preferences  
- `activeTab` – Access current tab information  

### Backend Integration
- **Worker Endpoints:** Configurable Cloudflare Worker URLs  
- **Authentication:** Google OAuth for user identification  
- **Storage:** Direct upload to R2 cloud storage  

---

Built with Chrome Extension APIs, Web Audio processing, and Cloudflare Workers integration.

