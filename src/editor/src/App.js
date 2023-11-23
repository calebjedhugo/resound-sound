import './App.css';
import ResoundSound from 'resound-sound';

function App() {
  return (
    <div className="App">
      <button
        onClick={() => {
          new ResoundSound().play();
        }}
      >
        Play
      </button>
    </div>
  );
}

export default App;
