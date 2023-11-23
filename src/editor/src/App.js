import './App.css';
import ResoundSound from 'resound-sound';

function App() {
  return (
    <div className="App">
      <button
        onClick={() => {
          new ResoundSound('sawtooth').play({ length: 500, pitch: 'Ab4' });
        }}
      >
        Play
      </button>
    </div>
  );
}

export default App;
