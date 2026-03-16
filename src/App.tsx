import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  GoogleAuthProvider, 
  signInWithPopup, 
  onAuthStateChanged, 
  User 
} from 'firebase/auth';
import { 
  doc, 
  getDoc, 
  setDoc, 
  collection, 
  addDoc, 
  serverTimestamp,
  onSnapshot,
  query,
  orderBy,
  limit
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { getGeminiClient } from './lib/gemini';
import { Modality, LiveServerMessage } from "@google/genai";
import { 
  Mic, 
  MicOff, 
  Camera, 
  Video, 
  User as UserIcon, 
  LogOut, 
  Activity, 
  Heart, 
  Utensils, 
  Dumbbell,
  Sparkles,
  ChevronRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utils ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---
interface UserProfile {
  uid: string;
  name: string;
  age?: number;
  weight?: number;
  fitnessGoal?: string;
  injuries?: string;
  createdAt: any;
}

interface ActivityLog {
  id: string;
  type: 'workout' | 'meal' | 'health';
  description: string;
  timestamp: any;
}

// --- Components ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);
  const [transcript, setTranscript] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);

  // Gemini Live Refs
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioInputRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);

  // --- Auth & Profile ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        const docRef = doc(db, 'users', u.uid);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          setProfile(docSnap.data() as UserProfile);
        } else {
          setShowProfileModal(true);
        }
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed", error);
    }
  };

  const handleLogout = () => auth.signOut();

  const saveProfile = async (data: Partial<UserProfile>) => {
    if (!user) return;
    const newProfile = {
      uid: user.uid,
      name: user.displayName || 'User',
      createdAt: serverTimestamp(),
      ...data
    };
    await setDoc(doc(db, 'users', user.uid), newProfile);
    setProfile(newProfile as UserProfile);
    setShowProfileModal(false);
  };

  // --- Gemini Live Logic ---
  const startLiveSession = async () => {
    if (!user) return;
    
    try {
      const ai = getGeminiClient();
      
      // Setup Audio Context
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      
      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: `You are LifeGuide AI, a multimodal personal life assistant. 
          The user is ${profile?.name || 'a user'}. 
          Goal: ${profile?.fitnessGoal || 'General wellness'}. 
          Injuries: ${profile?.injuries || 'None'}.
          Be encouraging, professional, and helpful. You can see through the camera and hear the user.
          If the user shows exercise, give form tips. If they show food, give nutritional advice.`,
        },
        callbacks: {
          onopen: () => {
            console.log("Live session opened");
            setIsLive(true);
            startAudioCapture();
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.inlineData?.data) {
                  // Handle audio output
                  const base64Audio = part.inlineData.data;
                  const binaryString = atob(base64Audio);
                  const bytes = new Uint8Array(binaryString.length);
                  for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                  }
                  // Convert PCM16 to Float32
                  const pcm16 = new Int16Array(bytes.buffer);
                  const float32 = new Float32Array(pcm16.length);
                  for (let i = 0; i < pcm16.length; i++) {
                    float32[i] = pcm16[i] / 32768.0;
                  }
                  audioQueueRef.current.push(float32);
                  if (!isPlayingRef.current) {
                    playNextInQueue();
                  }
                }
              }
            }
            
            if (message.serverContent?.interrupted) {
              audioQueueRef.current = [];
              isPlayingRef.current = false;
            }
          },
          onclose: () => {
            console.log("Live session closed");
            stopLiveSession();
          },
          onerror: (err) => console.error("Live session error", err),
        },
      });

      sessionRef.current = await sessionPromise;
    } catch (error) {
      console.error("Failed to start live session", error);
    }
  };

  const stopLiveSession = () => {
    setIsLive(false);
    setIsRecording(false);
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioInputRef.current) {
      audioInputRef.current.getTracks().forEach(t => t.stop());
      audioInputRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    audioQueueRef.current = [];
    isPlayingRef.current = false;
  };

  const startAudioCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      audioInputRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      const source = audioContextRef.current!.createMediaStreamSource(stream);
      const processor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
      
      processor.onaudioprocess = (e) => {
        if (!sessionRef.current) return;
        const inputData = e.inputBuffer.getChannelData(0);
        // Convert Float32 to PCM16
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 32767;
        }
        const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
        sessionRef.current.sendRealtimeInput({
          media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
        });
      };
      
      source.connect(processor);
      processor.connect(audioContextRef.current!.destination);
      processorRef.current = processor;
      setIsRecording(true);
    } catch (err) {
      console.error("Audio capture failed", err);
    }
  };

  const playNextInQueue = () => {
    if (audioQueueRef.current.length === 0 || !audioContextRef.current) {
      isPlayingRef.current = false;
      return;
    }

    isPlayingRef.current = true;
    const chunk = audioQueueRef.current.shift()!;
    const buffer = audioContextRef.current.createBuffer(1, chunk.length, 24000); // TTS/Live is often 24k
    buffer.getChannelData(0).set(chunk);
    
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    source.onended = () => playNextInQueue();
    source.start();
  };

  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || !sessionRef.current || !isLive) return;
    
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    
    // Draw video to canvas
    ctx.drawImage(videoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);
    
    // Convert to base64 jpeg
    const base64Data = canvasRef.current.toDataURL('image/jpeg', 0.5).split(',')[1];
    
    sessionRef.current.sendRealtimeInput({
      media: { data: base64Data, mimeType: 'image/jpeg' }
    });
  }, [isLive]);

  useEffect(() => {
    let interval: any;
    if (isLive) {
      interval = setInterval(captureFrame, 1000); // Send frame every second
    }
    return () => clearInterval(interval);
  }, [isLive, captureFrame]);

  // --- UI ---
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0502] flex items-center justify-center">
        <motion.div 
          animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="text-emerald-500"
        >
          <Sparkles size={48} />
        </motion.div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0a0502] text-white flex flex-col items-center justify-center p-6 overflow-hidden relative">
        {/* Atmospheric Background */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-900/20 blur-[120px] rounded-full" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-900/20 blur-[120px] rounded-full" />
        </div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="z-10 text-center max-w-2xl"
        >
          <div className="flex justify-center mb-8">
            <div className="w-20 h-20 bg-emerald-500/10 rounded-3xl flex items-center justify-center border border-emerald-500/20">
              <Sparkles className="text-emerald-500" size={40} />
            </div>
          </div>
          <h1 className="text-6xl font-light tracking-tight mb-4 font-serif">LifeGuide AI</h1>
          <p className="text-zinc-400 text-lg mb-12 leading-relaxed">
            Your multimodal personal life assistant. Seeing, hearing, and guiding you towards your best self.
          </p>
          <button 
            onClick={handleLogin}
            className="bg-white text-black px-8 py-4 rounded-full font-medium flex items-center gap-3 hover:bg-zinc-200 transition-colors group"
          >
            Connect with Google
            <ChevronRight size={20} className="group-hover:translate-x-1 transition-transform" />
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0502] text-white font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="p-6 flex justify-between items-center border-b border-white/5 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-500/10 rounded-xl flex items-center justify-center border border-emerald-500/20">
            <Sparkles className="text-emerald-500" size={24} />
          </div>
          <span className="text-xl font-serif tracking-tight">LifeGuide</span>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-end mr-2">
            <span className="text-sm font-medium">{profile?.name || user.displayName}</span>
            <span className="text-[10px] text-zinc-500 uppercase tracking-widest">{profile?.fitnessGoal || 'Wellness'}</span>
          </div>
          <button 
            onClick={() => setShowProfileModal(true)}
            className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center hover:bg-zinc-700 transition-colors"
          >
            <UserIcon size={20} />
          </button>
          <button 
            onClick={handleLogout}
            className="w-10 h-10 rounded-full bg-zinc-800/50 flex items-center justify-center hover:bg-red-900/20 hover:text-red-400 transition-all"
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Main Content: Live Interaction */}
        <div className="space-y-6">
          <div className="relative aspect-video bg-zinc-900 rounded-3xl overflow-hidden border border-white/5 shadow-2xl group">
            <video 
              ref={videoRef}
              autoPlay 
              playsInline 
              muted 
              className={cn(
                "w-full h-full object-cover transition-all duration-1000",
                isLive ? "opacity-100 scale-100 blur-0" : "opacity-50 scale-105 blur-[2px]"
              )}
            />
            <canvas ref={canvasRef} width={640} height={480} className="hidden" />
            
            {!isLive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm">
                <div className="w-20 h-20 bg-emerald-500/20 rounded-full flex items-center justify-center mb-6 animate-pulse">
                  <Video className="text-emerald-500" size={32} />
                </div>
                <h2 className="text-2xl font-serif mb-2">Ready to start?</h2>
                <p className="text-zinc-400 mb-8">Enable camera and voice for real-time guidance.</p>
                <button 
                  onClick={startLiveSession}
                  className="bg-emerald-500 hover:bg-emerald-400 text-black px-8 py-3 rounded-full font-medium transition-all shadow-lg shadow-emerald-500/20"
                >
                  Start Live Session
                </button>
              </div>
            )}

            {isLive && (
              <div className="absolute bottom-6 left-6 right-6 flex justify-between items-end">
                <div className="flex gap-3">
                  {/* Live Status Indicator */}
                  <div className="bg-black/60 backdrop-blur-md px-4 py-2 rounded-2xl border border-white/10 flex items-center gap-2 shadow-[0_0_15px_rgba(239,68,68,0.2)]">
                    <div className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]"></span>
                    </div>
                    <span className="text-xs font-mono uppercase tracking-widest text-red-500 font-bold">Live</span>
                  </div>

                  {/* Audio Activity Indicator */}
                  <div className={cn(
                    "bg-black/60 backdrop-blur-md px-4 py-2 rounded-2xl border transition-all duration-300 flex items-center gap-2",
                    isRecording 
                      ? "border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.2)]" 
                      : "border-white/10"
                  )}>
                    <div className="relative">
                      <Mic className={cn(
                        "size-4 transition-all duration-300", 
                        isRecording ? "text-emerald-400 drop-shadow-[0_0_5px_rgba(52,211,153,0.8)]" : "text-zinc-500"
                      )} />
                      {isRecording && (
                        <motion.div 
                          animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
                          transition={{ duration: 1.5, repeat: Infinity }}
                          className="absolute inset-0 bg-emerald-500/20 rounded-full -z-10"
                        />
                      )}
                    </div>
                    <span className={cn(
                      "text-xs font-mono uppercase tracking-widest transition-colors duration-300",
                      isRecording ? "text-emerald-400" : "text-zinc-500"
                    )}>
                      {isRecording ? "Audio Active" : "Mic Muted"}
                    </span>
                  </div>
                </div>
                
                <button 
                  onClick={stopLiveSession}
                  className="bg-red-500/20 hover:bg-red-500 text-red-500 hover:text-white p-4 rounded-2xl border border-red-500/20 transition-all backdrop-blur-md group"
                >
                  <MicOff size={24} className="group-hover:scale-110 transition-transform" />
                </button>
              </div>
            )}
          </div>

          {/* AI Status / Guidance */}
          <div className="bg-zinc-900/50 rounded-3xl p-8 border border-white/5 backdrop-blur-sm">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-12 h-12 bg-emerald-500/10 rounded-2xl flex items-center justify-center border border-emerald-500/20">
                <Activity className="text-emerald-500" size={24} />
              </div>
              <div>
                <h3 className="text-xl font-serif">AI Insights</h3>
                <p className="text-xs text-zinc-500 uppercase tracking-widest">Real-time Analysis</p>
              </div>
            </div>
            
            <div className="space-y-4 text-zinc-300 leading-relaxed">
              {isLive ? (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col gap-4"
                >
                  <p className="italic text-emerald-400/80">"I'm watching and listening. How can I help you today?"</p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
                      <span className="text-[10px] text-zinc-500 uppercase block mb-1">Visual Focus</span>
                      <span className="text-sm">Human / Environment</span>
                    </div>
                    <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
                      <span className="text-[10px] text-zinc-500 uppercase block mb-1">Activity Detection</span>
                      <span className="text-sm">Standing / Talking</span>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <p>Start a session to receive real-time coaching and life guidance. I can help with workouts, nutrition, and general health tips.</p>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Profile Modal */}
      <AnimatePresence>
        {showProfileModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
              onClick={() => profile && setShowProfileModal(false)}
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-zinc-900 w-full max-w-md rounded-[40px] p-10 border border-white/10 shadow-2xl"
            >
              <h2 className="text-3xl font-serif mb-2">Personalize LifeGuide</h2>
              <p className="text-zinc-400 mb-8 text-sm">Tell me about yourself so I can provide better guidance.</p>
              
              <form onSubmit={(e) => {
                e.preventDefault();
                const formData = new FormData(e.currentTarget);
                saveProfile({
                  age: Number(formData.get('age')),
                  weight: Number(formData.get('weight')),
                  fitnessGoal: String(formData.get('fitnessGoal')),
                  injuries: String(formData.get('injuries')),
                });
              }} className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-[10px] text-zinc-500 uppercase tracking-widest ml-1">Age</label>
                    <input name="age" type="number" defaultValue={profile?.age} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 focus:outline-none focus:border-emerald-500/50 transition-colors" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] text-zinc-500 uppercase tracking-widest ml-1">Weight (kg)</label>
                    <input name="weight" type="number" defaultValue={profile?.weight} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 focus:outline-none focus:border-emerald-500/50 transition-colors" />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] text-zinc-500 uppercase tracking-widest ml-1">Fitness Goal</label>
                  <input name="fitnessGoal" type="text" defaultValue={profile?.fitnessGoal} placeholder="e.g. Muscle gain, Weight loss" className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 focus:outline-none focus:border-emerald-500/50 transition-colors" />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] text-zinc-500 uppercase tracking-widest ml-1">Injuries / Conditions</label>
                  <textarea name="injuries" defaultValue={profile?.injuries} placeholder="e.g. Knee pain, Asthma" className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 focus:outline-none focus:border-emerald-500/50 transition-colors h-24 resize-none" />
                </div>
                
                <button type="submit" className="w-full bg-emerald-500 text-black py-4 rounded-2xl font-medium hover:bg-emerald-400 transition-colors shadow-lg shadow-emerald-500/10">
                  Save Profile
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
