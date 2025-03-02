from datetime import datetime, timezone
from sqlalchemy import create_engine, Column, Integer, String, DateTime, JSON, Float
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from typing import Dict, Any

Base = declarative_base()
engine = create_engine('sqlite:///knowledge_graphs.db')
Session = sessionmaker(bind=engine)

class KnowledgeGraph(Base):
    __tablename__ = 'knowledge_graphs'
    
    id = Column(Integer, primary_key=True)
    topic = Column(String, index=True, nullable=False)
    concept_count = Column(Integer, nullable=False)
    concepts = Column(JSON, nullable=False)
    relationships = Column(JSON, nullable=False)
    likes = Column(Integer, default=0)
    dislikes = Column(Integer, default=0)
    score = Column(Float, default=0)  # likes - dislikes
    created_at = Column(DateTime, default=datetime.now(timezone.utc))
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'topic': self.topic,
            'concept_count': self.concept_count,
            'concepts': self.concepts,
            'relationships': self.relationships,
            'likes': self.likes,
            'dislikes': self.dislikes,
            'score': self.score,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'is_like': bool(self.likes > self.dislikes) if hasattr(self, 'is_like') else None
        }

class UserView(Base):
    __tablename__ = 'user_views'
    
    id = Column(Integer, primary_key=True)
    user_id = Column(String, index=True, nullable=False)  # UUID
    graph_id = Column(Integer, nullable=False)
    viewed_at = Column(DateTime, default=datetime.utcnow)

# 创建数据库表
Base.metadata.create_all(engine) 