from sqlalchemy import desc
from models import Session, KnowledgeGraph, UserView
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone

class DatabaseManager:
    @staticmethod
    def save_knowledge_graph(topic: str, concept_count: int, concepts: dict, relationships: list, is_person: int = 0) -> int:
        with Session() as session:
            graph = KnowledgeGraph(
                topic=topic.lower(),
                concept_count=concept_count,
                concepts=concepts,
                relationships=relationships,
                is_person=is_person  # 保存是否为人物的标记
            )
            session.add(graph)
            session.commit()
            return graph.id

    @staticmethod
    def get_best_graph(topic: str, concept_count: int, exclude_ids: List[int] = None) -> Optional[Dict[str, Any]]:
        with Session() as session:
            query = session.query(KnowledgeGraph)\
                .filter(KnowledgeGraph.topic == topic.lower())\
                .filter(KnowledgeGraph.concept_count == concept_count)
            
            # 如果有需要排除的图谱ID，确保它们是整数列表
            if exclude_ids:
                exclude_ids = [int(id) for id in exclude_ids]
                query = query.filter(~KnowledgeGraph.id.in_(exclude_ids))
            
            total_available = query.count()
            if total_available == 0:
                return None
            
            graph = query.order_by(desc(KnowledgeGraph.score)).first()
            if graph:
                result = graph.to_dict()
                result['total_available'] = total_available
                return result
            
            return None

    @staticmethod
    def update_feedback(graph_id: int, is_like: bool) -> Dict[str, Any]:
        with Session() as session:
            graph = session.query(KnowledgeGraph).get(graph_id)
            if not graph:
                raise ValueError(f"Graph with id {graph_id} not found")
            
            if is_like:
                graph.likes += 1
            else:
                graph.dislikes += 1
            
            graph.score = graph.likes # - graph.dislikes 可调整，目前只取like数
            graph.created_at = datetime.now(timezone.utc)
            session.commit()
            return graph.to_dict()

    @staticmethod
    def record_user_view(user_id: str, graph_id: int) -> None:
        """
        记录用户对某个图谱的查看
        """
        with Session() as session:
            # 为避免重复记录，这里可以先检查是否已存在记录
            exists_view = session.query(UserView).filter(
                UserView.user_id == user_id,
                UserView.graph_id == graph_id
            ).first()
            if not exists_view:
                view = UserView(user_id=user_id, graph_id=graph_id)
                session.add(view)
                session.commit()

    @staticmethod
    def get_user_best_graph(topic: str, concept_count: int, user_id: str) -> Optional[Dict[str, Any]]:
        """
        查询该用户未查看过的缓存知识图谱
        """
        with Session() as session:
            # 查询该用户已查看的图谱ID列表
            subquery = session.query(UserView.graph_id).filter(UserView.user_id == user_id)
            query = session.query(KnowledgeGraph)\
                .filter(KnowledgeGraph.topic == topic.lower())\
                .filter(KnowledgeGraph.concept_count == concept_count)\
                .filter(~KnowledgeGraph.id.in_(subquery))
            
            total_available = query.count()
            if total_available == 0:
                return None
            
            graph = query.order_by(desc(KnowledgeGraph.score)).first()
            if graph:
                result = graph.to_dict()
                result['total_available'] = total_available
                return result
            
            return None

    @staticmethod
    def get_top_n_graphs(topic: str, concept_count: int, user_id: str, n: int = 3) -> List[Dict[str, Any]]:
        """
        获取用户未查看过的前N个最佳图谱
        """
        with Session() as session:
            # 首先检查该主题和概念数量的总图谱数
            total_graphs = session.query(KnowledgeGraph)\
                .filter(KnowledgeGraph.topic == topic.lower())\
                .filter(KnowledgeGraph.concept_count == concept_count)\
                .count()
            print(f"总共找到 {total_graphs} 个符合条件的图谱")

            viewed_ids = session.query(UserView.graph_id)\
                .filter(UserView.user_id == user_id)\
                .scalar_subquery()
            
            query = session.query(KnowledgeGraph)\
                .filter(KnowledgeGraph.topic == topic.lower())\
                .filter(KnowledgeGraph.concept_count == concept_count)\
                .filter(~KnowledgeGraph.id.in_(viewed_ids))\
                .order_by(desc(KnowledgeGraph.score))
            
            graphs = query.limit(n).all()
            print(f"找到 {len(graphs)} 个未查看的图谱")
            return [graph.to_dict() for graph in graphs]

    @staticmethod
    def get_viewed_count(topic: str, concept_count: int, user_id: str) -> int:
        """
        获取用户已查看的指定主题和概念数量的图谱数量
        """
        with Session() as session:
            viewed_graphs = session.query(UserView.graph_id)\
                .join(KnowledgeGraph, UserView.graph_id == KnowledgeGraph.id)\
                .filter(KnowledgeGraph.topic == topic.lower())\
                .filter(KnowledgeGraph.concept_count == concept_count)\
                .filter(UserView.user_id == user_id)\
                .count()
            return viewed_graphs

    @staticmethod
    def get_default_graph() -> Optional[Dict[str, Any]]:
        """
        获取默认的知识图谱（主题为"人工智能"，概念数量为20，评分最高的）
        """
        with Session() as session:
            print("正在查询默认图谱...")  # 添加调试日志
            graph = session.query(KnowledgeGraph)\
                .filter(KnowledgeGraph.topic == "人工智能")\
                .filter(KnowledgeGraph.concept_count == 12)\
                .order_by(desc(KnowledgeGraph.score))\
                .first()
            
            print(f"查询结果: {'找到图谱' if graph else '未找到图谱'}")  # 添加调试日志
            
            if graph:
                return graph.to_dict()
            return None

# 在模块末尾创建数据库表
from models import Base, engine
Base.metadata.create_all(engine) 